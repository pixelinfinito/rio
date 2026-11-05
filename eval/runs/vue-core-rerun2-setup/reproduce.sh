#!/usr/bin/env bash
# Run from the Rio repository root, with a NEW output directory as argument 2.
set -euo pipefail
case_pr=${1:?PR required (12701 or 15328)}
case_out=${2:?new output directory required}
rio_bin=/home/ubuntu/rio/target/release/rio
[[ "$($rio_bin --version)" == 'rio 0.1.0 x86_64-unknown-linux-gnu f6e4f87e4c65' ]]
case "$case_pr" in
  12701)
    node_pin=22.14.0
    base_pin=35aeae7fa3168adcf9ed95fd35495d17c8b93eeb
    head_pin=cc34f2e4b1490d55a18c9f8e4f83bda855a6e105
    ;;
  15328)
    node_pin=24.22.2
    base_pin=a2b40db9a83b36ed9da3a16403cf8f040262d73f
    head_pin=57c730ab498aba29c525099d0a32529ff6d392e4
    ;;
  *) exit 2 ;;
esac
export PATH="/tmp/node-v${node_pin}-linux-x64/bin:$PATH"
export TMPDIR=/dev/shm PUPPETEER_SKIP_DOWNLOAD=true
# Check free space first; these runs started with ~6 GiB available.
df -h /dev/shm
mkdir -p /dev/shm/vue-core-rerun2
python3 eval/runner.py --repository vuejs/core --pr "$case_pr" \
  --base "$base_pin" --head "$head_pin" --languages typescript \
  --rio "$rio_bin" --out "$case_out" \
  --install-plan "eval/runs/vue-core-${case_pr}-attempt-02/install-plan.json" \
  --profile "eval/runs/vue-core-${case_pr}-attempt-02/profile.yaml" \
  --temp-root /dev/shm/vue-core-rerun2
