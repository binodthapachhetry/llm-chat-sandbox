# llm-chat-sandbox
Minimal Node.js chat app for experimenting with open-weight LLM inference (Ollama, vLLM, TGI) and evaluating scaling, caching, and streaming strategies for future FedRAMP-compliant deployment.

## Deploy to AWS App Runner

The following workflow builds the container image locally, pushes it to Amazon ECR in `us-east-1`, and creates an App Runner service that pulls the image. Replace any placeholder values (e.g., service name, secrets) as needed.

1. **Authenticate & prepare ECR.**
   ```bash
   aws configure set default.region us-east-1
   aws ecr create-repository --repository-name llm-chat-sandbox --image-scanning-configuration scanOnPush=true --encryption-configuration encryptionType=KMS || true
   aws ecr get-login-password --region us-east-1 | \
     docker login --username AWS --password-stdin 786869172188.dkr.ecr.us-east-1.amazonaws.com
   ```

2. **Build for App Runner's architecture and push.**
   ```bash
   docker buildx build --platform linux/amd64 -t llm-chat-sandbox:latest .
   docker tag llm-chat-sandbox:latest 786869172188.dkr.ecr.us-east-1.amazonaws.com/llm-chat-sandbox:latest
   docker push 786869172188.dkr.ecr.us-east-1.amazonaws.com/llm-chat-sandbox:latest
   ```

3. **Create (or update) the App Runner service.** Set environment variables for your model provider in `--environment-variables` or through the console.
   ```bash
   aws apprunner create-service \
     --service-name llm-chat-sandbox \
     --source-configuration '{
       "ImageRepository": {
         "ImageIdentifier": "786869172188.dkr.ecr.us-east-1.amazonaws.com/llm-chat-sandbox:latest",
         "ImageRepositoryType": "ECR",
         "ImageConfiguration": {
           "Port": "8080",
           "RuntimeEnvironmentVariables": [
             {"Name": "PROVIDER", "Value": "ollama"},
             {"Name": "OLLAMA_MODEL", "Value": "llama3"}
           ]
         }
       },
       "AutoDeploymentsEnabled": true
     }'
   ```

   If the service already exists, use `aws apprunner update-service --service-arn <ARN> --source-configuration ...` with the same payload to roll out a new revision. App Runner creates the `AWSServiceRoleForAppRunner` service-linked IAM role automatically the first time it needs to pull from ECR; confirm that role exists (or create it manually) if you see image authorization errors.

4. **Verify locally before deploying.**
   ```bash
   docker run --rm --platform linux/amd64 -p 8080:8080 \
     -e PROVIDER=ollama -e OLLAMA_MODEL=llama3 \
     786869172188.dkr.ecr.us-east-1.amazonaws.com/llm-chat-sandbox:latest
   curl http://localhost:8080/
   ```

App Runner defaults to HTTP health checks on `/` using port `8080`, which matches the Dockerfile’s `EXPOSE 8080` and the server’s `PORT` environment variable.
