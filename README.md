# Pterodactyl Deploy · GitHub Action

Deploy your build artefacts to a **Pterodactyl** server directly from your CI. Fast, simple, and CI-friendly.

## ✨ Features

- 🔐 Upload via panel-signed URL (no SFTP faff)
- 🔁 Optional server restart during deploy (`restart: true` by default)
- 🧹 Optional pre-deploy clean that preserves `.env`
- 🗜️ Zips your selected folder and decompresses server-side
- 🧾 Run post-deploy console commands with `run`


## 🚀 Quick Start

Add a job step to your workflow:

```yml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy to Pterodactyl
        uses: JustArtiom/ptero-deploy@v1
        with:
          url: ${{ secrets.PTERO_URL }}
          api_key: ${{ secrets.PTERO_API_KEY }}
          server_id: ${{ secrets.PTERO_SERVER_ID }}
          base_path: ./
          destination_path: ./
          restart: true
          clean: true
          run: |
            echo "Hello World" 
```


⸻

🔑 Using GitHub Secrets

Store sensitive values in Repository → Settings → Secrets and variables → Actions:  
-	PTERO_URL – e.g. https://panel.example.com. 
-	PTERO_API_KEY – your Client API key from the Pterodactyl panel. 
-	PTERO_SERVER_ID – the server ID shown in the panel URL

Reference them in your workflow with ${{ secrets.MY_SECRET }} as shown in the examples.

⸻

🧩 Inputs

| Name              | Required | Default | Description |
|-------------------|:--------:|:-------:|-------------|
| `url`             | ✅       | —       | The URL of your Pterodactyl panel (e.g. https://panel.example.com). |
| `api_key`         | ✅       | —       | Your Pterodactyl Client API key. Keep it in GitHub Secrets. |
| `server_id`       | ✅       | —       | The target server ID. |
| `base_path`       | ❌       | `./`     | Local path (relative to repo root) to upload, e.g. ./dist. |
| `destination_path`| ❌       | `./`     | Destination directory on the server, e.g. ./public or ./ |
| `restart`         | ❌       | `true`  | Whether to restart the server during deploy. |
| `clean`           | ❌       | `false` | If true, deletes all files except .env in destination_path before upload. |
| `run`             | ❌       | —    | Newline-separated console commands to run after deploy. Quotes are stripped automatically. |

Tip: Commands in run are sent one by one to the server console with a short delay.

⸻

🤝 Who is this for?

Anyone deploying apps or static assets to a Pterodactyl-managed server from GitHub Actions. It’s friendly for beginners and smooth for power users.

⸻