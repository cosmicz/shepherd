#!/usr/bin/env bash
# Open the demo in Google Chrome: window 1 = the demo pages in script order
# (share this window with Shepherd), window 2 = the companion, window 3 = the
# judge trace page. Run after `node demo/serve.mjs` (tab B) and the runtime
# (tab A) are up. Usage: demo/open-demo.sh [pages-port] [runtime-port]
set -euo pipefail
pages_port=${1:-8099}; runtime_port=${2:-4317}
pages=(weather news mail security-alert seniorcenter inbox messages consumer)
# Opt in to the unmeasured image-rich scenarios; the original eight stay intact.
if [[ ${SHEPHERD_EXTRA_DEMO_TABS:-0} == 1 ]]; then pages+=(account-review device-update community); fi
urls=()
for p in "${pages[@]}"; do urls+=("http://$p.localhost:$pages_port/"); done
open -na "Google Chrome" --args --new-window "${urls[@]}"
sleep 1
open -na "Google Chrome" --args --new-window "http://127.0.0.1:$runtime_port/companion"
sleep 1
open -na "Google Chrome" --args --new-window "http://127.0.0.1:$runtime_port/trace"
echo "Opened: window 1 (${#pages[@]} pages), window 2 (companion), window 3 (trace)."
echo "Share window 1 from the companion; keep window 3 on the judge display."
