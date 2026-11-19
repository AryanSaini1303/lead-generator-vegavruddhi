# lead-generator-vegavruddhi

Prototype: WhatsApp template outreach to past customers, with replies captured in Google Sheets.
No database and no frontend: **the Google Sheet is the customer list and the lead tracker.**

```
customers.csv --import--> Google Sheet (Leads tab) <--read/write--> send-batch script (your Mac)
                                   ^
                                   +----read/write---- Express webhook server (EC2) <-- Meta
```

## What happens
1. `npm run send` reads unsent, non-opted-out rows from the **Leads** tab and sends the approved template (name in `{{1}}`, buttons Yes / No / Stop).
2. Meta calls `POST /webhook` with delivery statuses and replies. Writes to the sheet are batched every few seconds to stay inside Sheets API quotas.
3. Button **Yes** -> `interested = yes`. **No** -> `interested = no`. **Stop** -> `do_not_contact = yes` (the sender never messages that number again).
4. Free text is tagged in the `intent` column (`interested`, `not_interested`, `stop`, `question`, `callback_later`, `wrong_number`, `other`, `needs_review`) with a short English `ai_summary`. One-word replies like "haan" or "nahi" are handled by free rules; the LLM (OpenAI, model set by `CLASSIFIER_MODEL`) only runs on the rest, a fraction of a paisa per message. A free-text "band karo" also sets `do_not_contact`. The raw chat is always kept in `reply_text`.
5. You and your partner review the sheet: fill `verified`, `reviewer_notes`, `handed_over`, and later `business_feedback`.

Columns are found **by header name**, so you can add, reorder or rename your own columns (e.g. `city`, `last_purchase`). Only `phone` and `name` are required from your side; `npm run setup-sheet` adds the rest.

## One-time setup
1. **Sheet:** create a Google Sheet. Import the CSV into a tab named `Leads` (File > Import), with columns `phone` and `name`. Format the `phone` column as *Plain text*.
2. **Google service account:** Cloud Console > create project > enable *Google Sheets API* > IAM > Service accounts > create > Keys > JSON. Save it as `service-account.json` here (it's gitignored). **Share the sheet with the service account's email as Editor.**
3. `cp .env.example .env` and fill it in (`SHEET_ID` is the long id in the sheet URL).
4. `npm install && npm run setup-sheet`
5. **Meta:** app > WhatsApp > Configuration > set Callback URL to `https://<your-host>/webhook` and Verify token to your `WEBHOOK_VERIFY_TOKEN`; subscribe to the **messages** field. Put the app secret in `META_APP_SECRET`.
6. Create the template (see `templates/solar-templates.md`), wait for approval, set `TEMPLATE_NAME`.

## Run
```bash
npm run selftest                              # fake sheet + fake WhatsApp, no credentials
npm start                                     # webhook server (use cloudflared/ngrok locally, EC2 later)

npm run send -- --only 9198xxxxxxxx,9199xxxxxxxx           # plan only, test numbers
npm run send -- --only 9198xxxxxxxx,9199xxxxxxxx --send    # really send to your test accounts
npm run send -- --limit 500                                # plan the pilot batch
npm run send -- --limit 500 --send                         # send it
```
`--send` is required to send anything; without it the script only prints the plan. It also stops early on rate-limit or repeated failures to protect the number's quality rating.

Add your 2-3 test numbers as rows in the sheet first. In Meta's test mode they must also be added as recipients under WhatsApp > API Setup.

## Deploy on EC2 (when the local test is happy)
Node 20+, `npm ci --omit=dev`, copy `.env` and the service-account file, run under `pm2 start src/server.js --name lead-gen`, and put HTTPS in front (nginx + certbot) on a subdomain such as `leads.<your-domain>`. The sender can keep running from your Mac; both talk to the same sheet.

## Known limits (fine for a prototype)
- Status and replies written by the server are cached in memory; the server reloads the sheet every 2 minutes, so manual edits are picked up shortly. Don't hand-edit `reply_text`, `status` or `intent` for a lead while that lead is actively replying.
- One WhatsApp number / one template at a time (`PHONE_NUMBER_ID`, `TEMPLATE_NAME`). A second vertical means a second deployment or a small routing change.
- Webhook de-duplication is in memory, so a server restart in the middle of a Meta retry could log one reply twice.

## Running batches from WhatsApp (admin commands)

Instead of `npm run send` on the server, trusted numbers listed in `ADMIN_PHONES` (comma separated, in `.env`)
can text the business number:

| Text | What happens |
|------|--------------|
| `send 50` | Plans a batch of up to 50. **Nothing is sent**; the bot replies with the plan (who is skipped, daily capacity left) |
| `confirm` | Sends exactly that plan (must be within 5 min, by the same admin) |
| `status` | Sent / delivered / read / failed / replies / waiting, daily capacity, batch progress |
| `stop` | Aborts a running batch after the current message (or cancels a pending plan) |
| `cancel` | Drops a pending plan |
| `help` | Lists commands |

Notes: `send --50`, `send message 50` and `initiate process 50` also work. One batch runs at a time. The daily cap
(`DAILY_SEND_CAP`) and the 131049 cooldown still apply, and `ADMIN_MAX_BATCH` (default 500) limits one command.
Admin texts that are not commands behave like ordinary customer replies, so an admin who is also a test lead can still
test reply handling (use "band karo" to test opt-out by text, because `stop` is the admin command).
If the server restarts mid-batch the run simply ends; already-sent rows are skipped on the next `send`.
Optional `.env`: `ADMIN_CONFIRM_TTL_MIN`, `ADMIN_SEND_DELAY_MS`, `ADMIN_PROGRESS_EVERY`.
