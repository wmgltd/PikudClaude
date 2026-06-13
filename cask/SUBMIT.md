# Submitting PikudClaude to Homebrew Cask

End-state: users on macOS can run `brew install --cask pikudclaude` —
no tap, no extra flags. To get there, you submit a PR to
`Homebrew/homebrew-cask` and wait for review (usually ~24-48h).

## Once v0.3.1 is out

1. Download the new DMG and compute its SHA256:
   ```bash
   curl -sSL -o /tmp/pkud.dmg \
     https://github.com/wmgltd/PikudClaude/releases/download/v0.3.1/PikudClaude-0.3.1-arm64.dmg
   shasum -a 256 /tmp/pkud.dmg | awk '{print $1}'
   ```
2. Edit `pikudclaude.rb` — bump `version` to `"0.3.1"` and replace the
   `sha256` with the value from step 1.

## Submit the PR

```bash
# Fork + clone (one-time)
gh repo fork Homebrew/homebrew-cask --clone --remote
cd homebrew-cask

# Create the branch
git checkout -b add-pikudclaude

# Copy in the cask (case-sensitive subdir is the first letter of the cask name)
mkdir -p Casks/p
cp /Users/kobisela/KobisWorkspace/pikudclaude/cask/pikudclaude.rb Casks/p/

# Run the homebrew-cask pre-flight checks
brew style Casks/p/pikudclaude.rb
brew audit --new --cask Casks/p/pikudclaude.rb
brew install --cask --verbose Casks/p/pikudclaude.rb    # end-to-end install test
brew uninstall --cask pikudclaude                       # cleanup

# Commit + push
git add Casks/p/pikudclaude.rb
git commit -m "Add pikudclaude 0.3.1"
git push origin add-pikudclaude

# Open the PR
gh pr create --repo Homebrew/homebrew-cask \
  --title "Add pikudclaude 0.3.1" \
  --body "PikudClaude is a multi-session terminal hub for Claude Code with Hebrew/RTL support. Apple Silicon only (no Intel build in upstream releases). Signed + notarized by WMG."
```

## After review

The cask reviewers will run their own audit and probably ask for a tweak or
two. Common asks:

- `caveats` block if the user needs to do anything post-install
- Confirming the DMG URL pattern is stable across versions
- Justifying any unusual `depends_on` or entitlements

Once merged, anyone with Homebrew can:

```bash
brew install --cask pikudclaude
```

…and `brew upgrade --cask` picks up new versions via the `livecheck` stanza.

## Future version bumps

Once the cask is live, you don't need a PR for every release — Homebrew has
an automated bot (`BrewTestBot`) that watches your GitHub release feed via
`livecheck` and opens version-bump PRs automatically. You just review +
merge.

If you ever need to bump manually:

```bash
brew bump-cask-pr pikudclaude --version 0.3.2
```
