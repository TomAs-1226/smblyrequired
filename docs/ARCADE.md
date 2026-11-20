# Arcade server: weekly code and leaderboard (Oracle Cloud)

The Cycle Rush game (`#/arcade`) runs entirely in the browser. This document is
about the small API in `server/arcade/` that runs on an Oracle Cloud *Always Free*
VM, behind Caddy for HTTPS. It does two things: it checks the **weekly code** the
arcade asks for, and it keeps the **leaderboard**. Until the site is built with
`VITE_ARCADE_API` pointing at it, the arcade is open and has no leaderboard.

> Public repo: no IPs, hostnames, or keys in this file. `<api-host>` is a
> placeholder; the real one lives in the password manager with the VM's SSH key.

```
  browser (frc5805.com)  ──HTTPS──▶  Caddy :443  ──▶  node server.mjs :8787 (localhost only)
                                                           └─ SQLite  /var/lib/arcade/arcade.db
```

## Why a separate host and not Firebase

The leaderboard is public and anonymous. Keeping it off Firebase keeps it out of
the portal's security rules entirely: nothing the arcade does can touch member
data, and a flood of fake scores cannot cost the team's Firebase quota.

## The weekly code

The arcade asks for a short code (like `K7Q-X3M`) before the game loads. The code
changes by itself at midnight every Monday, Pacific time: it is worked out from a
secret only the server holds and the week's number (`server/arcade/access.mjs`), so
nobody has to set it. A correct code gets a pass that works until the week rolls
over; that browser is not asked again that week.

**To get the code** for this week and next, on the VM:

```bash
sudo bash /opt/arcade/code.sh
```

Share it however the team shares things (it is fine to post next week's code ahead
of time). Wrong guesses are limited to 8 per 10 minutes per address.

**What it does and does not protect.** It keeps the arcade page closed to anyone
without the code, and the leaderboard only takes scores from someone who has it.
It does not hide the game's files: those are public on GitHub Pages like the rest
of the site, and someone who goes looking can download them.

**To change the code early** (say it leaked), replace the secret and restart:

```bash
sudo sed -i "s/^ARCADE_CODE_SECRET=.*/ARCADE_CODE_SECRET=$(openssl rand -hex 32)/" /etc/arcade.env
sudo systemctl restart arcade
```

Everyone's pass stops working and this week's code changes. **To open the arcade
to everyone**, delete the `ARCADE_CODE_SECRET` line from `/etc/arcade.env` and
restart. If the server is down, the arcade says it cannot check codes and offers to
try again; it does not open by itself.

## The API

| Call | Does |
|---|---|
| `GET /api/health` | `{ ok: true }` |
| `GET /api/access` | `{ required }`: whether a code is asked for |
| `POST /api/unlock` `{ code }` | this week's code in, `{ pass }` out |
| `POST /api/check` `{ pass }` | `{ ok }`: is the pass good for this week |
| `POST /api/runs` `{ difficulty }` | starts a match, returns `{ run }`. Needs `Authorization: Bearer <pass>` |
| `POST /api/scores` `{ run, name, difficulty, blue, red, made, fired }` | posts a finished match, returns `{ rank }`. Needs the pass |
| `GET /api/scores?difficulty=regional` | top 10 |

The game is client-side, so **scores can be faked** by someone determined. What the
server does about it: a score needs a `run` id issued at least 158 s earlier (a
match is 163 s), each run posts once, numbers are bounded, names are filtered, and
each address gets 12 posts per 10 minutes. Remove a bad row by hand (below).

Environment (set in `/etc/arcade.env` on the VM to override the unit's defaults):

| Variable | Default |
|---|---|
| `ARCADE_ORIGINS` | `https://frc5805.com,https://www.frc5805.com,http://localhost:5173` |
| `ARCADE_DB` | `/var/lib/arcade/arcade.db` |
| `ARCADE_MIN_MATCH_SECONDS` | `158` |
| `ARCADE_CODE_SECRET` | made by `setup.sh` on first install (64 hex characters). Unset: no code |

## Setting it up

### 1. Oracle Cloud account (a person does this)

Sign up at Oracle Cloud for the Free Tier. It asks for a card to verify identity;
Always Free resources are not charged. Use a team-owned email so the account
outlives any one student, and put the login in the password manager. Pick a home
region close to SoCal (`US West (San Jose)` or `US West (Phoenix)`); it cannot be
changed later, and Always Free compute only runs in the home region.

### 2. The VM

Compute → Instances → Create instance:

- **Image:** Canonical Ubuntu 24.04
- **Shape:** Ampere `VM.Standard.A1.Flex`, 1 OCPU, 6 GB (well inside Always Free).
  If it says *out of capacity*, try another availability domain or try again later;
  `VM.Standard.E2.1.Micro` (AMD, also Always Free) works too.
- **Networking:** create a new VCN with a public subnet; assign a public IPv4.
- **SSH key:** upload a public key; keep the private key in the password manager.

Then make the address permanent: Networking → IP management → Reserved public IPs,
and attach it to the instance, so DNS never breaks on a reboot.

### 3. Open ports 80 and 443

Networking → Virtual cloud networks → your VCN → Security Lists → Default →
Add ingress rules: source `0.0.0.0/0`, TCP, destination ports `80` and `443`.

The VM has its **own** iptables firewall too, which rejects everything but SSH on
Oracle's Ubuntu image. `setup.sh` opens 80/443 there; both layers must allow it.

### 4. DNS (optional)

Add an `A` record for the API hostname (for example a subdomain of the team domain)
pointing at the reserved IP. Without a domain, `setup.sh` falls back to
`<ip>.sslip.io`, which resolves to the IP with no DNS work and still gets a real
certificate.

### 5. Install

```bash
ssh ubuntu@<api-host>
git clone https://github.com/TomAs-1226/smblyrequired.git
cd smblyrequired/server/arcade
sudo bash deploy/setup.sh <api-host>
```

It installs Node 24 and Caddy, creates an `arcade` system user, installs the
systemd unit (`arcade.service`, sandboxed to write only `/var/lib/arcade`), opens
the firewall, writes the Caddyfile, and adds a nightly SQLite copy to
`/var/lib/arcade/backups` (14 kept). Check from your own machine:

```bash
curl https://<api-host>/api/health
```

### 6. Point the site at it

Add `VITE_ARCADE_API=https://<api-host>` to `.env.local`, then `npm run deploy`.
Vite inlines it at build time; the leaderboard appears under the game.

## Running it

```bash
# update to the latest main
cd ~/smblyrequired && git pull && sudo bash server/arcade/deploy/setup.sh <api-host>

journalctl -u arcade -f            # logs
systemctl status arcade caddy

# remove a score
sudo -u arcade sqlite3 /var/lib/arcade/arcade.db \
  "SELECT id, name, difficulty, blue, red FROM scores ORDER BY id DESC LIMIT 20;"
sudo -u arcade sqlite3 /var/lib/arcade/arcade.db "DELETE FROM scores WHERE id = <id>;"
```

Oracle may reclaim an Always Free instance it judges idle (very low CPU, network
and memory use over a week). A leaderboard that people play is unlikely to hit
that, but if the instance vanishes, the nightly copies in `/var/lib/arcade/backups`
are on the same disk; copy one off occasionally if the scores matter.

## Locally

```bash
cd server/arcade
npm test                                         # 14 tests, throwaway database
ARCADE_MIN_MATCH_SECONDS=0 ARCADE_DB=./data/dev.db npm start
# then, in the repo root:
VITE_ARCADE_API=http://localhost:8787 npm run dev
```
