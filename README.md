# Commit Message

A Claude Code mod: `/commit-msg` drafts a commit message for the staged changes and then commits or amends with it. It never pushes.

- **Drafted outside the conversation.** The staged diff, the stat and the recent messages go to a separate model call, so no raw diff lands in your chat.
- **Your repo's rules, or its history.** The first format file found (see Settings) is followed exactly. Without one, the draft copies the style of the recent commits: Conventional Commits, `[AREA]` tags, subject length, body.
- **Commit, Amend or Leave staged.** The dialog shows the draft. Amend merges the draft into HEAD's message and is labelled `Amend (HEAD is pushed)` when HEAD is already on a remote branch. Leave staged prints the draft and commits nothing.
- **What it left out.** Partly staged, unstaged and untracked files are listed under the draft, along with any file diff cut for size.

`/commit-msg <hint>` steers emphasis and wording (`/commit-msg call out the breaking change`). The command shows up only in a git work tree, and it runs git from the repo's top level.

A project skill or command also named `commit-msg` (one kept for another agent, say) keeps its listing, but typing `/commit-msg` in a git repo runs this plugin instead. The skill still answers when the model picks it from a plain request ("draft a commit message"), and outside a git repo.

## Settings

Set at install, or in `/config` from a terminal session:

| Setting | Default | What it does |
| --- | --- | --- |
| `format_files` | `.claude/commit-format.md, .github/commit-format.md` | Comma-separated repo-relative paths; the first that exists holds the rules |
| `model` | `sonnet` | Drafts the message and merges it on an amend (`sonnet`, `haiku`, `opus`) |
| `exclude` | `.idea` | Comma-separated pathspecs left out of the diff the drafter reads |
| `history` | `10` | Recent commit messages read for the house style |
| `max_file_chars` | `12000` | Per-file diff cap, so a lockfile or spec cannot crowd out the rest |

A format file is plain Markdown: tag scheme, line length, what to skip, ordering. Anything you would tell a reviewer about your commit style.

## Install

At the prompt of a terminal session:

```
/plugin install commit-msg --marketplace tnt1232007/claude-plugin-commit-msg
```

From a shell:

```
claude plugin install commit-msg --marketplace tnt1232007/claude-plugin-commit-msg
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `tnt1232007/claude-plugin-commit-msg`, then Add plugin.

For development, add a local clone as the marketplace instead, so an edit loads after `/reload-plugins`:

```
claude plugin marketplace add <path to this folder>
claude plugin install commit-msg@commit-msg
```

## Develop

```
claude plugin validate .
claude plugin test .
```
