# Modern Drivers — office dashboard

The web address the Modern Dairy office uses to run driver tracking:

**https://veerbhagtani.github.io/modern-drivers/**

## There is no source code here

This repository is an address, not a project. The dashboard is built in
[modern-dairy-app](https://github.com/VeerBhagtani/modern-dairy-app) on the
`modern-drivers-standalone` branch, under `dashboard/`. A workflow here copies
the built site across every twenty minutes and publishes it to `gh-pages`.

It is arranged this way round — pulling from there rather than pushing from
there to here — because that repository is public, so the copy needs no token,
no deploy key, and nothing anyone has to remember to rotate.

**Change the dashboard in the other repository.** Anything edited here will be
overwritten on the next run.

## To publish immediately instead of waiting

**Actions → Publish the office dashboard → Run workflow.**

## If the site ever stops updating

Check the Actions tab here first. The usual causes:

- the source branch was renamed, so the clone step fails and says so;
- GitHub paused scheduled workflows, which it does on repositories left
  untouched for 60 days — one manual run re-enables them.
