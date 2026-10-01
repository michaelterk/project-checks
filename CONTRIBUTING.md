# Contributing

Use Node 26 or later. The package has no npm dependencies or build step.

```sh
npm test
npm run resources
npm pack --dry-run
```

The tests include cache and scheduler regressions, actual commands in temporary
projects, and installing the packed artifact into an independent project.
Add a regression test when changing cache validity, discovery, scheduling,
cancellation or command execution. Keep project-specific behavior in the
consumer's configuration or adapter.

For a release, update `package.json`, run the checks above, and inspect the archive
with `npm pack`. Publishing requires the maintainer's npm account and an available package
name; this repository does not publish automatically.
