<!-- Copyright Mor3 Inc., 2026 All Rights Reserved. -->

# CRaM: Remaining Steps

Status as of Nov 16, 2026: the code is finished, tested, and pushed to GitHub (private repo).
The keys are saved offline. The database is empty and ready for first-time setup.

| # | Task | Who | Time |
|---|------|-----|------|
| 1 | Fix the LICENSE wording | Claude | 2 min |
| 2 | Buy the domain and move it to Cloudflare | You | 15 min (plus up to 24 h for DNS) |
| 3 | Pick and create a server | You + Claude | 20 min |
| 4 | Install CRaM on the server | Claude walks you through it | 30 min |
| 5 | Connect the domain with Cloudflare Tunnel | You + Claude | 15 min |
| 6 | Lock access to your team with Cloudflare Access | You | 10 min |
| 7 | Create the admin account and turn on 2FA | You | 5 min |
| 8 | Add the team | You | 2 min per person |
| 9 | Set up automatic backups | Claude | 15 min |

---

## 1. Fix the LICENSE wording

The current `LICENSE` starts with the MIT License, which grants anyone with a copy free permission
to use, copy and modify the software. That contradicts "All Rights Reserved". Claude will replace it
with a short proprietary notice ("All rights reserved. No license is granted…") that keeps your
employee-only restrictions. Then push.

---

## 2. Domain → Cloudflare

1. Buy the domain from any registrar (Cloudflare Registrar sells at cost, which makes the next steps automatic).
2. Cloudflare dashboard → **Add a domain** → enter it → choose the **Free** plan.
3. Cloudflare shows two nameservers. At your registrar, replace the existing nameservers with those two.
4. Wait for Cloudflare's "your domain is active" email (usually under an hour, at most 24 h).
5. Decide the address for CRaM, e.g. `cram.yourdomain.com`.

---

## 3. Pick a server (not this Mac)

CRaM needs a machine that is **always on** and has a **persistent disk**, because the SQLite
database is a file. It's tiny (about 1 GB of RAM is plenty).

| Option | Cost | Notes |
|--------|------|-------|
| **Small cloud server (recommended)**: DigitalOcean Droplet, Hetzner Cloud, AWS Lightsail | $5–12/mo | Ubuntu 24.04 LTS, 1 GB RAM. Simple and reliable |
| Always-on office mini PC | One-time hardware cost | Works, but depends on office power and internet |
| Render / Railway / Fly.io | $7–20/mo | Must add a persistent disk; more setup quirks with SQLite |

When creating the cloud server:
- Image: **Ubuntu 24.04 LTS**
- Login: **SSH key** (not password). Claude can generate one on your Mac.
- Region: closest to your team
- Turn on automatic backups/snapshots if offered (about $1–2/mo)

---

## 4. Install CRaM on the server

Run these on the server (`ssh root@SERVER-IP`). Claude will tailor them on the day.

```bash
# System updates, firewall, automatic security patches
apt update && apt -y upgrade
apt -y install git unattended-upgrades ufw
ufw allow OpenSSH && ufw --force enable        # NO web ports open; Cloudflare Tunnel connects outward

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs

# Dedicated user for the app
adduser --disabled-password --gecos "" cram
```

**Get the code** (read-only deploy key, so the server can never change GitHub):
```bash
sudo -u cram ssh-keygen -t ed25519 -N "" -f /home/cram/.ssh/id_ed25519
cat /home/cram/.ssh/id_ed25519.pub
# GitHub → CRaM repo → Settings → Deploy keys → Add → paste → leave "write access" OFF
sudo -u cram git clone git@github.com:notmyemailagain2-ux/CRaM.git /home/cram/app
cd /home/cram/app && sudo -u cram npm ci --omit=dev
```

**Put the secret keys back** from your password manager, as one line each, no extra spaces:
```bash
sudo -u cram nano /home/cram/app/.data-key      # paste data-key, save
sudo -u cram nano /home/cram/app/.jwt-secret    # paste jwt-secret, save
chmod 600 /home/cram/app/.data-key /home/cram/app/.jwt-secret
```

**Settings file:**
```bash
sudo -u cram cp /home/cram/app/.env.example /home/cram/app/.env
sudo -u cram nano /home/cram/app/.env     # set: HOST=127.0.0.1
```

**Run it as a service** (starts on boot, restarts if it crashes):
```bash
cat > /etc/systemd/system/cram.service <<'EOF'
[Unit]
Description=CRaM
After=network.target

[Service]
User=cram
WorkingDirectory=/home/cram/app
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now cram
systemctl status cram          # should say "active (running)"
journalctl -u cram -n 20       # shows the SETUP CODE for step 7
```

---

## 5. Cloudflare Tunnel (connects the domain to the server, with no open ports)

1. Cloudflare dashboard → **Zero Trust** → Networks → **Tunnels** → **Create a tunnel** → Cloudflared → name it `cram`.
2. Choose **Debian/Ubuntu**. Cloudflare shows an install command with a long token. Run it on the server.
3. **Public hostname:** subdomain `cram`, domain `yourdomain.com`, service type **HTTP**, URL `localhost:3000` → Save.
4. Main Cloudflare dashboard → your domain → **SSL/TLS** → mode **Full**. Then **Edge Certificates** → turn on **Always Use HTTPS**.

---

## 6. Cloudflare Access (only your team can even see the sign-in page)

1. Zero Trust → **Access** → **Applications** → Add → **Self-hosted**.
2. Application domain: `cram.yourdomain.com`. Session duration: 24 hours.
3. Policy: **Allow** → Include → **Emails** (list each teammate), or **Emails ending in** `@yourdomain.com` once company email exists.
4. Login method: **One-time PIN** (emailed code, no setup needed).
5. Save. Visiting the site now asks for an email PIN first, then the CRaM sign-in with 2FA.

Free for up to 50 users.

---

## 7. Create the admin account

1. Get the setup code: `journalctl -u cram -n 20` on the server.
2. Go to `https://cram.yourdomain.com`, enter the setup code, your name, work email and a strong password.
3. Scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy).
4. **Save the 10 recovery codes** in your password manager.
5. Use the key icon to confirm your password works; use the shield icon for new recovery codes later.

---

## 8. Add the team

CRaM → **Team** → **Add Team Member** → name, email, role (User or Admin), starting password.
(If using Cloudflare Access with an email list, add their email there too.)

Message to send each person (share the password separately, e.g. in person or by phone):

> Your CRaM account is ready at https://cram.yourdomain.com
> 1. Enter your email to get a one-time PIN, then sign in with the password I gave you.
> 2. Install an authenticator app and scan the QR code.
> 3. Save your 10 recovery codes somewhere safe; you need them if you forget your password.
> 4. Change your password using the key icon (top right).

---

## 9. Automatic backups

Claude will set up:
- A nightly `npm run backup` on the server (a cron job) that keeps the last 30 days.
- An off-server copy (e.g. Cloudflare R2 or another cloud bucket), so a dead server can't take the data with it.
- A tested restore, so we know the backups actually work.

Keep `.data-key` with the backups in your password manager (already done).

---

## Later / nice-to-have

- **Email password reset**, once the company email domain exists (needs a sending service such as Postmark or Amazon SES).
- **Updating CRaM after changes:** on the Mac, push to GitHub; on the server run
  `cd /home/cram/app && sudo -u cram git pull && sudo -u cram npm ci --omit=dev && systemctl restart cram`
- **Team Portal content:** announcements and resources can be added whenever you like.

---

## Quick reference

| What | Where |
|------|-------|
| Code | https://github.com/notmyemailagain2-ux/CRaM (private) |
| Project on this Mac | `Documents/DEVELOPMENT/CRM` |
| Secret keys | Your password manager (`.data-key`, `.jwt-secret`) |
| Old demo-data backups | `Documents/DEVELOPMENT/CRM/backups/` (safe to delete) |
| Original pre-review files | `Documents/DEVELOPMENT/CRM/backup-original-2026-11-16/` (safe to delete once happy) |

<!-- Copyright Mor3 Inc., 2026 All Rights Reserved. -->
