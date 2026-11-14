# GitFerry updates

- Build application updates on GitHub, not locally, and install the matching GitHub-built artifact.
- After a successful update, verify the installed version, signature, app launch, and preserved preferences, then remove `~/Library/Caches/GitFerry-updates` and any temporary installer/staging files created for that update. This includes downloaded installers, old app backups, and verification metadata. Do not accumulate versioned update caches.
- An optional MCP/view check blocked by a locked Mac must not leave update artifacts behind once the installation itself is verified.
- Before cleanup, ensure no installer image from the cache is mounted and no process is running from it. On a failed installation, retain the rollback needed for recovery until the failure is resolved.
- Cleanup must leave `/Applications/GitFerry.app`, app settings, WebView data, Keychain entries, and repository files intact.
