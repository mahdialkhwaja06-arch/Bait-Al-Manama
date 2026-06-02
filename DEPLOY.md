# Bait Al-Manama — Cloudflare Deployment Guide

## What you need
- A free Cloudflare account (cloudflare.com)
- A free GitHub account (github.com)
- That's it — no credit card, no paid plans.

---

## Step 1 — Create a GitHub repository

1. Go to **github.com** → sign in → click the **+** button → **New repository**
2. Name it `bait-almanama`
3. Set it to **Private**
4. Click **Create repository**
5. On the next screen, click **uploading an existing file**
6. Drag and drop ALL the files from this zip into the page
7. Click **Commit changes**

---

## Step 2 — Create a Cloudflare KV Namespace

1. Go to **dash.cloudflare.com** → sign in
2. In the left menu, go to **Workers & Pages** → **KV**
3. Click **Create a namespace**
4. Name it `bait-almanama-kv`
5. Click **Add**
6. **Copy the ID** that appears — you'll need it in Step 4

---

## Step 3 — Create a Cloudflare Pages project

1. In Cloudflare dashboard → **Workers & Pages** → **Create**
2. Click **Pages** → **Connect to Git**
3. Connect your GitHub account if asked
4. Select the `bait-almanama` repository
5. Build settings:
   - **Framework preset**: None
   - **Build command**: (leave empty)
   - **Build output directory**: `public`
6. Click **Save and Deploy**

---

## Step 4 — Add the KV binding

After the first deploy finishes:

1. Go to your Pages project → **Settings** → **Functions**
2. Scroll to **KV namespace bindings**
3. Click **Add binding**
   - **Variable name**: `KV`  ← must be exactly this
   - **KV namespace**: select `bait-almanama-kv`
4. Click **Save**
5. Go back to **Deployments** and click **Retry deploy** (or push any change to GitHub)

---

## Step 5 — You're live!

Cloudflare gives you a free URL like:
`https://bait-almanama.pages.dev`

You can also add a custom domain for free in Pages → **Custom domains**.

---

## Making updates in the future

Whenever you get a new zip from Claude:
1. Go to your GitHub repository
2. Click on the file you want to update (e.g. `public/staff.html`)
3. Click the pencil icon (Edit) or delete and re-upload
4. Commit the change
5. Cloudflare automatically redeploys in ~30 seconds

---

## Free tier limits (you'll never hit these)

| Resource | Free limit | Your usage |
|----------|-----------|------------|
| Requests | Unlimited | ✅ |
| Bandwidth | Unlimited | ✅ |
| KV reads | 100,000/day | ~500/day ✅ |
| KV writes | 1,000/day | ~300/day ✅ |
| KV storage | 1 GB | ~5 MB ✅ |
| Functions | Unlimited requests | ✅ |
