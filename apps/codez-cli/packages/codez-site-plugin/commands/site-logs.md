---
description: Show the logs of a Codez Sites deployment and explain any failure.
argument-hint: "[deployment id]"
skills: site-deploy
---

Use the `site-deploy` skill for this request:

$ARGUMENTS

Find the deployment: use the id in the arguments, or the latest deployment from `codez-site status`. Read it with `codez-site logs <deploymentId>` and explain what happened. For a failure, give the cause and the fix (see the skill's troubleshooting reference).
