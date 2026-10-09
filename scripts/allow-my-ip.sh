#!/usr/bin/env bash
# Use when your home IP changes. The operator IP is part of the CloudFormation template
# (DatabaseSecurityGroup, via operatorCidr in config/aws.generated.yml), so it must not be
# edited out of band: that would conflict with the next deploy and never revoke stale IPs.
# deploy.sh rediscovers the current public IP, rewrites operatorCidr and redeploys.
set -euo pipefail
exec "$(dirname "$0")/deploy.sh" "$@"
