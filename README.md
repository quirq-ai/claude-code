# claude-code

One container that runs [Claude Code](https://code.claude.com) with **Remote Control** on. You sign in once
with your own Claude subscription, then drive the session from [claude.ai/code](https://claude.ai/code) or the
Claude app. No API key is needed.

## Run

```bash
docker build -t claude-code .
docker run -d --name cc -p 8080:8080 -v cc-data:/data claude-code
docker logs -f cc
```

The logs print a **CONNECT** link:

```
12:45:19 CONNECT: http://localhost:8080/connect#Xb3…
```

1. Open it. The page has a **Sign in to Claude** link; sign in with your subscription.
2. Paste the code Claude shows into the page and press **Connect**.
3. The container starts `claude remote-control`. Open claude.ai/code or the Claude app and pick the session
   (the page and the logs show its name and links).

Prefer the terminal? `docker run -it …` and paste the code straight into it instead.

The sign-in is kept in the `/data` volume, so restarting the container goes straight to Remote Control.

## Why not a token?

Remote Control needs a full sign-in. Long-lived tokens from `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`)
are inference-only and Remote Control refuses them, so the container runs `claude auth login` and takes the code back.

## Security

- The connect page needs the token from the CONNECT link (random per start, or `CONNECT_TOKEN`). The token is
  in the link's `#fragment`, so it is not sent in requests or Referer headers; the page sends it as a bearer.
  Only whoever can read the container's logs can open the page.
- The sign-in code only works for this container's own login attempt (PKCE), so it is useless if seen elsewhere.
- Runs as the unprivileged `node` user. Nothing secret is in the image or its env.
- Anyone with the connect link can sign the container in to *their* account; keep the logs private.

## Settings

| Variable | Default | |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:$PORT` | The address used in the CONNECT link (e.g. the app's URL) |
| `CONNECT_TOKEN` | random per start | Fix the connect token instead |
| `SESSION_NAME` | `claude-code-<random>` | The session's name in claude.ai/code |
| `PERMISSION_MODE` | Claude Code's default | Passed to `--permission-mode` (e.g. `acceptEdits`) |
| `TASK` | — | Written to `TASK.md` in the work directory |
| `WORKDIR` | `/data/work` | Where Claude works (trusted automatically) |
| `PORT` | `8080` | Connect page and `GET /healthz` |

## Launchpad

`launchpad/template.yaml` runs the same image as a Launchpad app: open the app's logs, follow the CONNECT link
(it uses the app's URL), sign in, and continue in the Claude app. Replace `<project>` with the Harbor project and
push the image as `registry.xo.builders/<project>/claude-code:0.1.0`.
