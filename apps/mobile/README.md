# Gutad mobile (Expo / React Native)

Consumer app (discover, order, track, reserve, tickets, rewards), **merchant tablet mode** (order inbox with device heartbeat, host stand, kitchen station & packing screens) and **driver mode** (availability, offers, navigation, proof-of-handoff, earnings) in one binary; modes appear under *Account* based on the signed-in user's roles.

```bash
npm install                      # from repo root
cd apps/mobile
EXPO_PUBLIC_API_URL=http://<lan-ip>:4000 npm start     # Expo Go / dev client
npm run typecheck
npm run build:android | build:ios                       # EAS (see eas.json)
```

Production API URL defaults to `https://api.gutad.io` (`app.json → extra.apiUrl`). Tokens are kept in SecureStore; push tokens are registered with the API after sign-in.
