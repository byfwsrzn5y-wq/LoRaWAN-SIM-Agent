#!/usr/bin/env sh
# Used by npm run dev. Override: LORAWAN_SIM_CONFIG=path/to.json npm run dev
sleep 2
exec node index.js -c "${LORAWAN_SIM_CONFIG:-configs/config.json}"
