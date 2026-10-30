icloneOS Web {{version}} (the Chrome app)

What it is
icloneOS Web is the icloneOS interface as an installable web app for Chrome on any computer. It is a window onto a
Hermes gateway that you run: the agent, its memory and its tools keep running on that gateway machine, never inside
Chrome. The gateway serves this app from its own address, so no other server, account or key is involved.

Step 1: start the gateway (on the Mac or Linux machine that has icloneOS installed)
  ./start-gateway.sh                      # this machine only: http://127.0.0.1:8787/
  ./start-gateway.sh --host 0.0.0.0 --port 8787
                                          # other computers on your network; needs the gateway sign-in
                                          # (Hermes dashboard auth) configured, the gateway refuses otherwise
Step 2: in Chrome open the address it prints, sign in if asked, then choose "Install icloneOS Web" in the address bar
        (or the menu > Cast, save and share > Install page as app).
        Chrome offers Install only on https:// or on localhost. On a plain http:// network address, put the gateway
        behind an HTTPS reverse proxy and set HERMES_DASHBOARD_PUBLIC_URL to the public https:// address.
Step 3: if the app shows "Gateway not reachable", the gateway is stopped: run step 1 again.

What works: chat, sessions, settings, the connection it is served from, email and messaging, skills, themes.
What is limited: updates show the gateway's runtime only; file previews work from uploads, not from local disk.
What is not available in the web app (they need the desktop app): iT terminals and the side terminal, the econ apps
(they need the acp CLI and the system keychain), the Privy ownership window, the HUD overlay, Quick Entry,
native notifications and zoom, iclone:// links, moving or revealing files on disk.

The service worker caches only the app's own files; it never caches /api, /ws, /login or /auth answers.

Verify the files
  shasum -a 256 -c SHA256SUMS.txt
