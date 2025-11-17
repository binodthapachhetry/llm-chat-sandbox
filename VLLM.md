# Running a vLLM OpenAI-Compatible Server on AWS EC2 (L4 GPU)

## 1. Launch a GPU EC2 instance

1. In the AWS console go to **EC2 → Instances → Launch instance**.
2. Set:
   - **Name**: `vllm-gpu-1`
   - **AMI**: **Deep Learning AMI GPU PyTorch (Ubuntu 20.04/22.04)**  
     > This AMI comes with NVIDIA drivers, CUDA, Docker, and DL frameworks pre-installed.
   - **Instance type**: `g6e.4xlarge` (1× NVIDIA L4, 46 GB GPU RAM).
   - **Key pair**: create/select a key pair and download the `.pem` if needed.

3. **Network settings → Security group** (can be locked down more later):
   - Inbound rules:
     - **SSH**: TCP `22` from **Your IP**.
     - **LLM API**: TCP `8000` from **Your IP** (or from your VPC/CIDR for internal use).
   - Outbound: leave default (allow all) for now.

4. **Storage**:
   - Root volume: 100–300 GB **gp3** is comfortable for several models (FP8 safetensors are large).
   - (Optional but recommended) Add a separate data volume (e.g., 200–500 GB **gp3**) that will be attached as `/dev/sdf`.  
     > We’ll mount this to `/models` so model downloads and caches survive re-deploys.

5. Launch the instance.

6. **Elastic IP** (recommended):  
   Allocate an Elastic IP and associate it with this instance so the public IP stays stable.

---

## 2. SSH into the instance

On your laptop:

```bash
ssh -i /path/to/your-key.pem ubuntu@<EC2_PUBLIC_IP>
# or ec2-user@<EC2_PUBLIC_IP> depending on the AMI; adjust the username.
```

> The Deep Learning AMI on Ubuntu normally uses the `ubuntu` user.  
> In commands below that mention `ec2-user`, replace with `ubuntu` if that’s your actual login user.

---

## 3. Configure NVIDIA container toolkit & Docker

```bash
# Configure NVIDIA toolkit to work with Docker
sudo nvidia-ctk runtime configure --runtime=docker

# Restart Docker to pick up the new config
sudo systemctl restart docker

# Pull the latest vLLM OpenAI-compatible image
sudo docker pull vllm/vllm-openai:latest
```

---

## 4. Prepare and mount the models volume

> This assumes you attached an EBS volume as `/dev/sdf` in the EC2 launch settings.  
> On some instances this may show up as `/dev/nvme1n1` instead; use `lsblk` to confirm.

```bash
# (Optional) Inspect disks so you know which device is your extra volume
lsblk

# Create filesystem on the new volume (only do this once on a *blank* volume)
sudo mkfs -t xfs /dev/sdf

# Create mount point
sudo mkdir -p /models

# Persist the mount across reboots
echo "/dev/sdf /models xfs defaults,nofail 0 2" | sudo tee -a /etc/fstab

# Mount now
sudo mount -a

# Give your login user ownership (replace ec2-user with ubuntu if needed)
sudo chown ec2-user:ec2-user /models
```

Create a dedicated directory for the torch compile cache:

```bash
sudo mkdir -p /models/torch_compile_cache
sudo chown ec2-user:ec2-user /models/torch_compile_cache
```

---

## 5. Create the vLLM systemd service

We’ll run vLLM as a systemd service that starts automatically with the instance and wraps a Docker container.

> Replace `<YOUR_HF_TOKEN>` below with your actual Hugging Face access token, or point to an env file if you prefer.

```bash
sudo tee /etc/systemd/system/vllm.service >/dev/null << 'EOF'
[Unit]
Description=vLLM OpenAI-Compatible Server
After=docker.service
Requires=docker.service

[Service]
User=ec2-user
# If your login user is "ubuntu", change the line above accordingly.
Restart=always
RestartSec=5

# Stop and remove any existing container before starting a new one
ExecStartPre=-/usr/bin/docker rm -f vllm

# Main vLLM container
ExecStart=/usr/bin/docker run   --gpus all   --ipc=host   -p 8000:8000   --name vllm   -e VLLM_WORKER_CONCURRENCY=1   -e HUGGING_FACE_HUB_TOKEN=<YOUR_HF_TOKEN>   -v /models:/models   -v /models/torch_compile_cache:/root/.cache/vllm/torch_compile_cache   -e HF_HOME=/models/hf   -e TORCH_CUDA_ARCH_LIST=8.9   vllm/vllm-openai:latest     --model RedHatAI/gemma-3-27b-it-FP8-dynamic     --download-dir /models/hf     --max-model-len 4096     --tensor-parallel-size 1     --enable-prefix-caching     --enforce-eager

ExecStop=/usr/bin/docker stop vllm

[Install]
WantedBy=multi-user.target
EOF
```

---

## 6. Enable and start the service

```bash
# Reload systemd so it picks up the new unit file
sudo systemctl daemon-reload

# Enable the service (start on boot) and start it now
sudo systemctl enable --now vllm
```

Reboot once to confirm the service comes up cleanly on startup:

```bash
sudo reboot
```

After the instance comes back up, SSH in again and verify:

```bash
# Check that the service is running
systemctl status vllm

# Tail container logs
sudo docker logs -f vllm
```

---

## 7. Health check from your laptop

From your laptop (not the EC2 instance):

```bash
curl http://<EC2_PUBLIC_IP>:8000/v1/models
```

You should see JSON listing the `RedHatAI/gemma-3-27b-it-FP8-dynamic` model if everything is working.

> If the request hangs or fails, check:
> - Security group inbound rule on port 8000.
> - `sudo docker logs -f vllm` for errors.
> - That the Elastic IP is correctly attached to this instance.

---

## 8. Using this server from your Node app

On your laptop, in the repo where your Node app runs, set the following `.env` variables:

```bash
PROVIDER=openai_compat
LLM_BASE_URL=http://<EC2_PUBLIC_IP>:8000
OPENAI_COMPAT_MODEL=RedHatAI/gemma-3-27b-it-FP8-dynamic
```

> - `PROVIDER=openai_compat` tells your app to talk to an OpenAI-compatible HTTP API.
> - `LLM_BASE_URL` points at your EC2 vLLM server.
> - `OPENAI_COMPAT_MODEL` must match the model name you passed in `--model` when starting vLLM.

From here, your application can call the vLLM server using the standard OpenAI-compatible endpoints (e.g., `/v1/chat/completions`, `/v1/completions`, etc.), depending on how your client library is wired.

---

## 9. Quick recap

- EC2 `g6e.4xlarge` (L4) with Deep Learning AMI.
- Extra EBS volume mounted at `/models` for model weights and caches.
- vLLM running in Docker, managed by systemd as `vllm.service`.
- Server exposed on port `8000` as an OpenAI-compatible API for your Node app.
