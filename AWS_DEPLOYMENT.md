# ☁️ MediaVault AWS Deployment Guide

This comprehensive guide walks you through deploying **MediaVault** onto Amazon Web Services (AWS). It covers architectural best practices, database persistence for SQLite, secret management, and step-by-step instructions for two deployment options:

1. **Option A: AWS App Runner / AWS Lightsail Containers (Recommended - Easiest & Fully Managed)**
2. **Option B: AWS EC2 (Virtual Machine with PM2, Nginx, and Free SSL)**

---

## 🔒 Security Best Practices

- **Never commit `.env` or API keys to GitHub:** Always keep secrets in `.env` (which is in `.gitignore`) or set them as AWS Environment Variables.
- **SQLite Persistence & Backups:** The database is saved at `data/media_vault.db`. When deploying on containers, mount a persistent volume so records survive container redeployments. Run `npm run backup-db` to take consistent snapshots with WAL checkpoints.
- **Multi-User HTTPS & Secure Cookies:** In production (`NODE_ENV=production`), session cookies (`mediavault_sid`) are automatically flagged with `HttpOnly`, `SameSite=Lax`, and `Secure` (HTTPS only).
- **Reverse Proxy Trust (`TRUST_PROXY`):** Express is configured with `app.set('trust proxy', 1)` to trust only the immediate reverse proxy (Nginx or AWS App Runner / ALB), preventing IP spoofing from unrestricted trust.
- **Legacy Record Migration:** Existing unassigned records start with `user_id = NULL` and are blocked from all web endpoints. Once you register your administrator account, assign your legacy items safely by running: `npm run claim-legacy <your_username>`.
- **Health Check:** MediaVault includes a built-in healthcheck at `GET /api/health` that returns `200 OK` for AWS Load Balancers.

---

## Option A: AWS Lightsail Containers / App Runner (Easiest)

AWS Lightsail Containers is the most cost-effective and beginner-friendly managed container service ($7/month, includes SSL, automated domain setup, and zero server maintenance).

### Step 1: Push Your Code to GitHub
1. Initialize git and commit your files (verify that `.env` and `data/` are ignored):
   ```bash
   git add .
   git commit -m "feat: MediaVault with GenAI and episode tracking"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/mediavault.git
   git push -u origin main
   ```

### Step 2: Build & Push the Docker Image
You can use **Amazon Elastic Container Registry (ECR)**:
```bash
# 1. Log in to your AWS ECR registry
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com

# 2. Create an ECR repository
aws ecr create-repository --repository-name mediavault --region us-east-1

# 3. Build and tag the Docker image
docker build -t mediavault .
docker tag mediavault:latest YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/mediavault:latest

# 4. Push the image to ECR
docker push YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/mediavault:latest
```

### Step 3: Launch on AWS App Runner or Lightsail
1. Open the **AWS App Runner** console.
2. Click **Create service** -> Select **Container registry** -> Choose your ECR image (`mediavault:latest`).
3. Set **Port** to `3000`.
4. Under **Environment variables**, securely add:
   - `GEMINI_API_KEY`: Your real Google AI Studio key.
   - `NODE_ENV`: `production`
   - `PORT`: `3000`
5. Click **Deploy**. App Runner will provide a live HTTPS URL (e.g. `https://xyz123.us-east-1.awsapprunner.com`).

---

## Option B: AWS EC2 (Ubuntu 24.04 LTS + PM2 + Nginx)

If you prefer a classic virtual private server (e.g., EC2 `t4g.small` or Lightsail Linux instance):

### Step 1: Provision EC2 Instance
1. Launch an **Ubuntu 24.04 LTS** instance (`t4g.micro` or `t3.micro` free tier).
2. Ensure Security Group inbound rules allow:
   - Port `22` (SSH)
   - Port `80` (HTTP)
   - Port `443` (HTTPS)

### Step 2: Connect and Install Node.js 24
```bash
ssh -i your-key.pem ubuntu@YOUR_EC2_PUBLIC_IP

# Update system packages
sudo apt update && sudo apt upgrade -y

# Install Node.js 24 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git nginx

# Verify installation
node -v # Should be v24.x
npm -v
```

### Step 3: Clone Code & Configure Environment
```bash
# Clone your private repository
git clone https://github.com/YOUR_USERNAME/mediavault.git /var/www/mediavault
cd /var/www/mediavault

# Install production dependencies
npm ci --omit=dev

# Create production .env file (KEEP SECRETS OUT OF GIT)
nano .env
```
Inside `.env`, insert:
```ini
PORT=3000
NODE_ENV=production
GEMINI_API_KEY=your_real_gemini_api_key_here
TRUST_PROXY=1
```

### Step 4: Run with PM2 (Process Manager)
```bash
sudo npm install -g pm2

# Start MediaVault with PM2
pm2 start server.js --name mediavault

# Enable automatic startup on server reboot
pm2 startup
pm2 save
```

### Step 5: Configure Nginx as Reverse Proxy
Create an Nginx configuration file:
```bash
sudo nano /etc/nginx/sites-available/mediavault
```
Paste the following:
```nginx
server {
    listen 80;
    server_name yourdomain.com; # Or your EC2 Public IP

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the configuration and reload Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/mediavault /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

### Step 6: Enable Free SSL with Let's Encrypt (Certbot)
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

---

## 💾 Automated Database Backups to Amazon S3

Because SQLite stores your media and books in a single file (`data/media_vault.db`), backing it up to Amazon S3 is simple and reliable.

Create a daily cron job on EC2:
```bash
# Install AWS CLI
sudo apt install -y awscli

# Test backing up database to S3
aws s3 cp /var/www/mediavault/data/media_vault.db s3://your-backup-bucket/backups/media_vault_$(date +%Y%m%d).db

# Add to crontab for daily backup at 3:00 AM
crontab -e
# Add line:
0 3 * * * aws s3 cp /var/www/mediavault/data/media_vault.db s3://your-backup-bucket/backups/media_vault_$(date +\%Y\%m\%d).db > /dev/null 2>&1
```
