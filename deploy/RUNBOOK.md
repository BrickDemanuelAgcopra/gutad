# Gutad VPS runbook (gutad.io)

## 1. Provision

- VPS: 2 vCPU / 4 GB RAM / 40 GB SSD minimum (Ubuntu 22.04/24.04 or Debian 12). 4 vCPU / 8 GB recommended once a pilot kitchen is live.
- DNS (at your registrar): `A gutad.io → <IP>`, `A www.gutad.io → <IP>`, `A api.gutad.io → <IP>`. Wait for propagation before the first deploy so Let's Encrypt can issue certificates.
- Open ports 22, 80, 443 (the deploy script configures `ufw` when present).

## 2. First deploy

```bash
ssh root@<IP>
git clone <your repo> /opt/gutad && cd /opt/gutad
./deploy/deploy.sh          # installs Docker, writes .env with random secrets, prints the admin password, exits
nano .env                   # confirm DOMAIN=gutad.io API_DOMAIN=api.gutad.io ACME_EMAIL=you@gutad.io
                            # set PAYMENT_PROVIDER/DELIVERY_PROVIDER/SMS/EMAIL keys when ready (mock/log work without)
./deploy/deploy.sh          # builds images, starts everything, waits for /health
```

Check: `https://gutad.io` (web), `https://api.gutad.io/health` (JSON `ok:true`), `https://api.gutad.io/docs` (Swagger). Sign in as `ADMIN_EMAIL` with the printed password.

To ship **without demo data** set `SEED_DEMO=false` in `.env` before the first run (admin + membership plans are still seeded).

## 3. Everyday operations

| Task | Command |
|---|---|
| Status | `docker compose -f docker-compose.prod.yml ps` |
| Logs | `docker compose -f docker-compose.prod.yml logs -f api worker web caddy` |
| Upgrade | `git pull && ./deploy/deploy.sh` (migrations run automatically at API start; zero data loss, short API restart) |
| Restart one service | `docker compose -f docker-compose.prod.yml restart worker` |
| DB shell | `docker compose -f docker-compose.prod.yml exec postgres psql -U gutad gutad` |
| Rotate JWT secret | edit `JWT_SECRET`, `./deploy/deploy.sh` (all users re-login) |
| Scale API | add `deploy: { replicas: 2 }` to `api` and keep one `worker` (jobs are Redis-locked; a second worker is safe but unnecessary) |

### Backups & restore

- Nightly logical backup at 02:30 UTC → `/opt/gutad/deploy/backups/gutad-YYYYMMDD-HHMMSS.dump` (14 days kept; `BACKUP_KEEP_DAYS`). Copy them off-box (rclone/S3 cron) — the VPS disk is a single point of failure.
- Manual backup: `docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U gutad -Fc gutad > now.dump`
- **Restore drill (do this before launch):**
  ```bash
  docker compose -f docker-compose.prod.yml stop api worker
  docker compose -f docker-compose.prod.yml exec -T postgres dropdb -U gutad gutad && \
  docker compose -f docker-compose.prod.yml exec -T postgres createdb -U gutad gutad
  cat deploy/backups/gutad-<stamp>.dump | docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U gutad -d gutad --no-owner
  docker compose -f docker-compose.prod.yml start api worker
  ```
- Uploaded files (courier documents) live in the bundled MinIO volume `objdata`, bucket `gutad-files`; the same nightly run writes `deploy/backups/files-YYYYMMDD-HHMMSS.tar.gz`. Restore: `docker compose -f docker-compose.prod.yml stop minio`, then `docker run --rm -v gutad_objdata:/data -v $PWD/deploy/backups:/b alpine sh -c 'rm -rf /data/* /data/.minio.sys && tar -xzf /b/files-<stamp>.tar.gz -C /data'`, then `start minio`.
- To use AWS S3 or Cloudflare R2 instead, set `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` in `.env` and redeploy (copy existing objects across first).
- Redis holds only caches, locks and throttles; losing it is harmless.

### Monitoring

- `GET /health` reports DB/Redis liveness, outbox & notification backlogs, unacknowledged orders (>10 min), failed/held payouts. Point an uptime monitor at `https://api.gutad.io/health` and alert on `ok:false` or `unacknowledgedOrders > 0`.
- Admin → *Integrations & health* shows failed inbound webhooks (replayable), stuck outbox events, integrations in error and offline devices.
- Finance → *Integrity*: unbalanced journal batches (must be 0), processor clearing net, unmatched items.
- Container logs are JSON, rotated (20 MB × 5). Forward with Loki/Vector if you want retention.

## 4. Going live with real providers

| Provider | Steps |
|---|---|
| Stripe | Create a Connect platform; set `PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` (same mode, test/live, as the secret key), `STRIPE_WEBHOOK_SECRET`; the API refuses to start if the keys are missing or malformed; add two webhook destinations to `https://api.gutad.io/webhooks/payments`: *Your account* for `payment_intent.*`, `charge.refunded`, `charge.dispute.*`, `transfer.*`, and *Connected accounts* for `account.updated`. Put both signing secrets in `STRIPE_WEBHOOK_SECRET`, comma-separated (`whsec_a,whsec_b`). Merchants complete Express onboarding from *Merchant → Finance → Set up payouts*. |
| DoorDash Drive | Request production access; set `DELIVERY_PROVIDER=doordash` + developer id / key id / signing secret; webhook `https://api.gutad.io/webhooks/delivery`. |
| Uber Direct | Set `DELIVERY_PROVIDER=uber` + customer id / client id / secret; webhook as above. |
| Twilio | `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either `TWILIO_FROM` (E.164 number) or `TWILIO_MESSAGING_SERVICE_SID` (MG…, for alphanumeric sender IDs / A2P 10DLC). Marketing SMS is only sent to consented users. |
| Email (Brevo) | Authenticate `gutad.io` in Brevo (DKIM CNAMEs set to DNS only; one SPF record: `v=spf1 include:_spf.mx.cloudflare.net include:spf.brevo.com ~all`), add `EMAIL_FROM` as a verified sender, then set `EMAIL_PROVIDER=brevo`, `BREVO_API_KEY=xkeysib-…`, `EMAIL_FROM=no-reply@gutad.io`, `EMAIL_FROM_NAME=Gutad`, `EMAIL_REPLY_TO=support@gutad.io`. Inbound mail to `support@gutad.io` is Cloudflare Email Routing (forward-only). Alternative: `EMAIL_PROVIDER=smtp` + `SMTP_URL=https://…` HTTP relay accepting `{from,to,subject,text}`. |
| Check | After `docker compose -f docker-compose.prod.yml up -d api worker` (env changes need a recreate), use **Admin → Settings → Messaging → Send test** for email and SMS (pick a template to preview it and send it with sample data). Email HTML comes from `apps/api/src/modules/notifications/email-layout.ts` (shared layout) and `templates.ts` (per-message content); times are shown in the restaurant's time zone. Errors from the provider are shown there and in the audit log (`messaging.test.failed`). |
| Push | Expo push works out of the box for EAS builds; set `EXPO_ACCESS_TOKEN` for higher limits. |
| Geocoding | `GEOCODER_PROVIDER=google` + key; wire the checkout "Verify address" button to Places Autocomplete (pilot uses a demo pin). |

## 5. Production gates (from the blueprint)

- [ ] Merchant authorization & regulatory check for the launch market (tax rate per location is `taxRateBps`; set the real one).
- [ ] Provider production access obtained; sandbox transactions reconciled through *Finance → Reconcile*.
- [ ] Backup restore rehearsed (section 3).
- [ ] DST test: book a reservation and schedule an order across the next DST change (`zonedTimeToUtc` is DST-aware).
- [ ] Out-of-order webhooks: replay a delivery `DELIVERED` then `PICKED_UP` event — the second is ignored (`IGNORED_*` event).
- [ ] Failed transfer: set a legal seller's payout account to empty → payout goes `HELD`, finance is notified.
- [ ] Refund after payout: refund a settled order → merchant balance goes negative and nets on the next statement.
- [ ] Mixed-brand cancellation, waitlist expiry, credit expiry: covered by the worker jobs (`jobs.service.ts`).
- [ ] Cross-tenant access: run `npm run smoke` (asserts customers cannot reach admin; org-scoped guards on every merchant route).
- [ ] Cost the pilot separately: platform settings `fees.*` require a second admin approver.

## 6. Mobile release

```bash
cd apps/mobile
npx eas login && npx eas build:configure
EXPO_PUBLIC_API_URL=https://api.gutad.io npx eas build -p android --profile production
EXPO_PUBLIC_API_URL=https://api.gutad.io npx eas build -p ios --profile production
```
Set `apiUrl` in `app.json → extra` if you prefer not to pass the env. Replace `assets/icon.png` and `assets/splash.png` with brand artwork (placeholders are solid brand color).
