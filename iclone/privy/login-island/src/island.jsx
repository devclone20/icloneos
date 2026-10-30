/* iCLONE OS — Privy login island. The ONLY React in the app, isolated behind
   window.PrivyIsland. It is served (by electron/iclone-privy.ts's loopback
   HTTP server, 127.0.0.1:47831) inside its own BrowserWindow — never inside
   the main renderer — because Privy needs a real secure-context origin and
   an isolated cookie partition ('persist:iclone-privy'), not the app's own
   window. privy.html lazy-loads the built bundle (privy-login.js, this file
   compiled) and talks to it through this tiny contract:
   init({appId, accent, onAuth, onLogout}) · open() · logout().

   Ported byte-for-byte (behavior, not text) from the CLONE FRAME HUB's proven
   login-island — same @privy-io/react-auth version, same Bridge invariants —
   because that pattern already survived adversarial QA. Only the default
   accent color changed (iCLONE gold, #d7c9a6, in place of the HUB's red) and
   comments now describe the Electron loopback-window hosting model instead of
   the HUB's same-origin static-file hosting model.

   Only the PUBLIC app id ever reaches this code — the Privy app secret is a
   server credential and must never appear here or anywhere in this repo.

   INVARIANT: open() must never be a silent no-op. Every path either shows the
   Privy modal, re-announces the live session through onAuth (so the app
   visibly resyncs), or queues the click until the SDK can do one of those.
   Three known ways to break this — swallowing the click on a stale-but-
   authenticated session, a single short retry dropping clicks that arrive
   before React mounts, and calling login() before the SDK is ready — all show
   the user the exact same thing: nothing. Keep the failsafe timeout below. */
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { base, mainnet } from 'viem/chains';

const cb = { onAuth: null, onLogout: null };
const api = {};          // filled by Bridge once the SDK is ready to act
let pendingOpen = false; // a click that arrived early — replayed on ready, never dropped

/* One definition of "what the session looks like", shared by the auth effect and by
   open()'s resync path so both always announce the same shape. Prefers a connected
   wallet's live provider; falls back to the linked-account address (session restored
   in a profile without the wallet extension — address known, provider absent). */
async function describeSession(user, wallets) {
  let address = null, provider = null, walletName = null;
  const w = wallets && wallets[0];
  if (w) {
    address = w.address;
    walletName = w.walletClientType || w.connectorType || 'wallet';
    try { provider = await w.getEthereumProvider(); } catch (_) {}
  } else {
    const la = ((user && user.linkedAccounts) || []).find(a => a.type === 'wallet');
    if (la) address = la.address;
  }
  return { user, address, provider, walletName };
}

function Bridge() {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets } = useWallets();

  useEffect(() => {
    api.logout = () => logout();
    api.forceLogin = () => { try { login(); } catch (_) {} }; // last resort; must never crash the island
    api.open = () => {
      if (!ready) { pendingOpen = true; return; } // SDK still starting: hold the click, replayed below
      if (authenticated && user) {
        // Already signed in on Privy's side: re-announce the session so the app
        // resyncs its button and state — feedback the user can actually see.
        describeSession(user, wallets).then(st => cb.onAuth && cb.onAuth(st));
      } else {
        api.forceLogin();
      }
    };
    if (ready && pendingOpen) { pendingOpen = false; api.open(); }
  }, [ready, authenticated, user, wallets, login, logout]);

  useEffect(() => {
    if (!ready) return;
    if (authenticated && user) describeSession(user, wallets).then(st => cb.onAuth && cb.onAuth(st));
    else if (!authenticated) cb.onLogout && cb.onLogout();
  }, [ready, authenticated, user, wallets]);

  return null;
}

window.PrivyIsland = {
  _mounted: false,
  init(cfg) {
    if (this._mounted) return;
    this._mounted = true;
    cb.onAuth = cfg.onAuth; cb.onLogout = cfg.onLogout;
    const el = document.createElement('div');
    el.id = 'privy-island';
    document.body.appendChild(el);
    createRoot(el).render(
      <PrivyProvider
        appId={cfg.appId}
        config={{
          appearance: { theme: 'dark', accentColor: cfg.accent || '#d7c9a6' },
          // Auto-provision an extension-free Privy embedded wallet so the login
          // window (a fresh, isolated 'persist:iclone-privy' partition with no
          // MetaMask) can still sign. v3 nested shape — the old flat
          // `createOnLogin` is ignored in @privy-io/react-auth 3.x.
          embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
          defaultChain: base,
          supportedChains: [base, mainnet],
          // Electron cannot complete OAuth redirect/popup flows for social
          // providers reliably (no custom-protocol-based redirect handler is
          // wired here) — email OTP + the auto-provisioned embedded wallet is
          // the one supported, recommended path. Leaving loginMethods unset
          // would surface Privy's dashboard-configured social buttons that
          // silently fail inside this window; pin to what actually works.
          loginMethods: ['email', 'wallet'],
        }}
      >
        <Bridge />
      </PrivyProvider>
    );
  },
  open() {
    if (api.open) api.open(); else pendingOpen = true;
    // Failsafe: on a surface where the SDK never reports ready (session iframe
    // blocked), a held click must still produce SOMETHING — try a raw login.
    setTimeout(() => { if (pendingOpen) { pendingOpen = false; api.forceLogin && api.forceLogin(); } }, 4000);
  },
  logout() { api.logout && api.logout(); },
};
