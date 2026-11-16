<!-- Copyright Mor3 Inc., 2026 All Rights Reserved. -->

# CRaM: Computations, Resolutions, and Management

Internal CRM for the Mor3 Inc. team.

- **CRaM** (`/`): customers, leads, deals, activity log, dashboard, team accounts
- **Team Portal** (`/landing.html`): live CRM numbers and quick actions

---

## Quick start

Requires **Node.js 22.13 or newer**. Nothing needs to be compiled.

```bash
npm install
npm start
```

Open http://localhost:3000.

### First-time setup

The database starts empty. On first start the terminal prints a one-time **setup code**.
Open the app, enter the code, and create the administrator account. Only someone who
can see the server terminal can do this. You'll then set up two-factor authentication.

### Security features

| Feature | Details |
|---------|---------|
| Strong passwords | 8+ characters with uppercase, lowercase, number and symbol. Common or predictable passwords, and passwords containing your name or email, are rejected |
| Two-factor (required) | Every account must set up an authenticator app (Google/Microsoft Authenticator, 1Password, Authy…) at first sign-in |
| Recovery codes | 10 one-time codes are issued with 2FA. Regenerate them from the shield icon |
| Account lockout | 5 failed attempts lock the account for 15 minutes |
| Secure sessions | httpOnly, SameSite=Strict cookies, never readable by page scripts; CSRF protection |
| Encryption at rest | 2FA secrets are encrypted with AES-256-GCM (`.data-key`) |
| Audit log | Sign-in lockouts, password resets and team changes are logged in the server output |

### Forgot password / lost phone

- **Forgot password:** "Forgot your password?" on the sign-in page, then enter a recovery code
  **plus** a code from the authenticator app.
- **Lost phone:** sign in with your password and use a recovery code in place of the 2FA code,
  then ask an admin to reset your two-factor so you can enroll the new phone.
- **Lost both:** an admin resets the password and/or two-factor on the **Team** page.

### Adding your team

Admin → **Team** → **Add Team Member**. Share the starting password privately. They set up
two-factor at first sign-in and should change their password (key icon).

| Role  | Can do |
|-------|--------|
| User  | View, add and edit customers, leads, deals and activities; delete their own activities |
| Admin | Everything above, plus delete any record and manage team members |

---

## Configuration

Copy `.env.example` to `.env` and edit as needed. Every setting is optional.

| Setting | Default | Purpose |
|---------|---------|---------|
| `PORT` | `3000` | Port to listen on |
| `HOST` | all interfaces | Set `127.0.0.1` behind Cloudflare Tunnel |
| `JWT_SECRET` | auto-generated in `.jwt-secret` | Signs logins |
| `JWT_EXPIRES_IN` | `8h` | How long a sign-in lasts |
| `DATA_KEY` | auto-generated in `.data-key` | Encrypts 2FA secrets |
| `DB_PATH` | `crm.db` | Database file |
| `TRUST_PROXY` | `loopback` | Correct for Cloudflare Tunnel |

**Keep private and backed up:** `.env`, `.jwt-secret`, `.data-key`, `crm.db` and `backups/` (all in `.gitignore`).
**If `.data-key` is lost, everyone's two-factor must be reset by an admin.** Back it up with the database.

---

## Going live with Cloudflare

The recommended setup for an internal tool is **Cloudflare Tunnel** plus **Cloudflare Access**:
no open ports on your network, automatic HTTPS, and only your team's email addresses
can even reach the sign-in page. Access is free for up to 50 users.

1. **Add the domain to Cloudflare** (Dashboard → Add a site) and switch your registrar's
   nameservers to the two Cloudflare gives you.
2. **On the computer that runs the CRM:**
   ```bash
   brew install cloudflared
   cloudflared tunnel login
   cloudflared tunnel create cram
   cloudflared tunnel route dns cram crm.YOURDOMAIN.com
   ```
3. Create `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: cram
   credentials-file: /Users/YOU/.cloudflared/<TUNNEL-ID>.json
   ingress:
     - hostname: crm.YOURDOMAIN.com
       service: http://localhost:3000
     - service: http_status:404
   ```
4. In `.env`, set `HOST=127.0.0.1` so the app is reachable **only** through the tunnel.
5. Start both: `npm start` and `cloudflared tunnel run cram`
   (or `sudo cloudflared service install` to run the tunnel automatically at boot).
6. **Lock it to your team:** Cloudflare Zero Trust → Access → Applications → Add →
   Self-hosted → `crm.YOURDOMAIN.com` → policy *Allow* → *Emails ending in*
   `@YOURDOMAIN.com` (or list individual emails).
7. In Cloudflare → SSL/TLS, set mode to **Full**, and enable **Always Use HTTPS**.

To keep the CRM running after you close the terminal, use a process manager such as
`npx pm2 start server.js --name cram && npx pm2 save`.

---

## Backups

```bash
npm run backup
```

Saves a consistent copy to `backups/crm-<date>.db`. It is safe to run while the server is
running. Schedule it daily and copy the `backups` folder somewhere off the machine.

To restore: stop the server, replace `crm.db` with a backup file, start the server.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Port 3000 is already in use" | Another copy is running. Stop it, or set `PORT` in `.env` |
| Everyone was signed out | Expected after `.jwt-secret` or `JWT_SECRET` changes |
| "Too many failed sign-in attempts" | Wait 15 minutes (protects against password guessing) |
| Forgot password | See *Forgot password / lost phone* above |
| "Request blocked for security reasons" | Refresh the page |

Check code for syntax errors with `npm run check`.

---

## Project structure

```
server.js            API server, database setup and security
scripts/backup.js    Database backup
public/
  index.html         CRM application
  app.js             CRM front-end logic
  landing.html       Team Portal
  landing.js         Team Portal live stats
  config.js          Product name (CRaM) / branding
  style.css          Shared styles
.env.example         Settings template
```

The original pre-review files are kept in `backup-original-2026-11-16/`.

---

Copyright Mor3 Inc., 2026 All Rights Reserved. Proprietary and confidential. For internal use only.

<!-- Copyright Mor3 Inc., 2026 All Rights Reserved. -->
