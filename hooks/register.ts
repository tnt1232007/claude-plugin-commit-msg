import type { EngineInterface, Register } from 'claude-code'

// A project skill or command of the same name may exist (one shared with another agent): the command.run hook
// answers before it, so /commit-msg runs this plugin in a git repo and the skill is left to everything else.
const COMMAND = 'commit-msg'

const SYSTEM = `You write one git commit message for the staged changes of a repository.
- When the user message gives format rules, follow them exactly.
- Without them, match the style of the recent messages: their subject prefix scheme (Conventional Commits, [AREA] tags, none), subject length, whether there is a body, and its wrapping.
- The recent messages show the style only. Never copy their content into the draft: no version numbers, release titles or lines that do not describe the staged diff.
- Write imperative summaries that name the actual entity, setting or behavior. Never "update files", "misc changes" or a list of file names.
- A change that is only noise (formatting, generated output, a lockfile or submodule pointer bump) gets no mention of its own unless the rules say otherwise.
- A <hint> from the user steers emphasis and wording; it does not override the rules.
- Add no trailers (Co-Authored-By, Signed-off-by) unless the rules ask for them.
Reply with exactly: the message inside one fenced code block, then one line per judgment call (something dropped as noise, a file grouped under another part). No other text.`

const MERGE_SYSTEM = `You merge a new commit message into the previous one, for a git commit --amend.
- When the user message gives format rules, follow them exactly; otherwise keep the previous message's style.
- Keep every line of the previous message, worded as it is, unless a new line covers the same change.
- When the messages group lines by a tag or scope, a tag in both ends up as one line naming both changes; new tags follow in the new message's order.
- Trailers (Co-Authored-By, Signed-off-by) once, at the end, after a blank line.
Reply with exactly the merged message inside one fenced code block. No other text.`

const COMMIT = 'Commit'
const AMEND = 'Amend'
const LEAVE = 'Leave staged'
const QUESTION = 'Commit the staged changes with the drafted message?'
const STAGE_ALL = 'Stage all'
const CANCEL = 'Cancel'

const fenced = (text: string) => text.match(/```[^\n]*\n([\s\S]*?)\n```/)?.[1]?.trim()
const list = (value: unknown) =>
  (Array.isArray(value) ? value.map(String) : String(value ?? '').split(','))
    .map(item => item.trim())
    .filter(Boolean)
const count = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback)

// One record per commit: RS, its tag decorations, US, its message. Control characters, so no message can fake a
// boundary and the model never sees a separator it could copy.
const LOG_FORMAT = '--format=%x1e%D%x1f%B'
const TAGGED = /(^|, )tag: /

// The newest `history` messages, each in <message>. A tagged commit is a release (a version bump), whose subject the
// drafter would otherwise copy above the real one; tagged commits are dropped unless every one is tagged.
function recentMessages(log: string, history: number) {
  const records = log
    .split('\x1e')
    .slice(1)
    .map(record => {
      const at = record.indexOf('\x1f')
      return { refs: record.slice(0, at), message: record.slice(at + 1).trim() }
    })
    .filter(record => record.message)
  const untagged = records.filter(record => !TAGGED.test(record.refs))
  return (untagged.length ? untagged : records)
    .slice(0, history)
    .map(record => `<message>\n${record.message}\n</message>`)
    .join('\n')
}

type Decision = { top: string; model: string; rules: string; message: string; previous: string; hasHead: boolean; isPushed: boolean }

// The draft the open Commit dialog shows as the preview of Commit and Amend. A logged line ($.ui.log) is one dim
// notice row and the dialog's question one paragraph, so either flattens the draft; an option preview keeps its lines.
// $.ui.ask takes labels only, so the plugin's own tool.call hook adds the previews on the way to the dialog.
let preview: { message: string; labels: string[] } | undefined

type Option = { label: string; description?: string; preview?: string }
type Question = { question: string; header?: string; options?: (Option | string)[]; multiSelect?: boolean }

function withPreview(questions: Question[], shown: { message: string; labels: string[] }) {
  return questions.map(q => {
    if (q.question !== QUESTION || !q.options) return q
    const options = q.options.map(option => {
      const o: Option = typeof option === 'string' ? { label: option } : option
      return shown.labels.includes(o.label) ? { ...o, description: o.description ?? '', preview: shown.message } : o
    })
    return { ...q, options }
  })
}

// Asks Commit / Amend / Leave staged once the draft is on screen, then acts and resolves the outcome line. Nothing here
// ever pushes.
async function decide($: EngineInterface, d: Decision): Promise<string> {
  const amendLabel = d.isPushed ? `${AMEND} (HEAD is pushed)` : AMEND
  const labels = [COMMIT, ...(d.hasHead ? [amendLabel] : []), LEAVE]
  // Dismissed, or no one to ask (a -p run): commit nothing.
  preview = { message: d.message, labels: [COMMIT, amendLabel] }
  const choice = await $.ui
    .ask(QUESTION, { header: 'Commit', options: labels })
    .catch(() => '')
    .finally(() => (preview = undefined))
  if (choice !== COMMIT && choice !== amendLabel) return 'commit-msg: left staged, nothing committed.'

  let final = d.message
  const args = ['commit', '-F', '-']
  if (choice === amendLabel) {
    $.ui.status('commit-msg: merging into the previous message...')
    const merged = await $.model.complete({
      model: d.model,
      system: MERGE_SYSTEM,
      prompt: [d.rules, `<previous_message>\n${d.previous}\n</previous_message>`, `<new_message>\n${d.message}\n</new_message>`].filter(Boolean).join('\n\n'),
      maxTokens: 2048,
      timeoutMs: 120_000,
    })
    $.ui.status(undefined)
    const mergedMessage = merged.isAnswered ? fenced(merged.text) : undefined
    if (!mergedMessage) return `commit-msg: not amended, the model gave no merged message${merged.isAnswered ? '' : ` (${merged.reason})`}. Changes left staged.`
    final = mergedMessage
    args.push('--amend')
  }

  const result = await $.process.run(['git', ...args], { cwd: d.top, stdin: `${final}\n` })
  if (result.exitCode !== 0) return `commit-msg: git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`
  const sha = (await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], { cwd: d.top })).stdout.trim()
  return args.includes('--amend') ? `commit-msg: amended ${sha} (draft merged into HEAD's message), not pushed.` : `commit-msg: committed ${sha}, not pushed.`
}

async function isRepo($: EngineInterface) {
  const root = await $.session.root()
  const probe = await $.process.run(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: root }).catch(() => undefined)
  return probe?.exitCode === 0 && probe.stdout.trim() === 'true'
}

export const register: Register = (on, options) => {
  const model = String(options.model || 'sonnet')
  const formatFiles = list(options.format_files)
  const excludes = list(options.exclude).map(path => `:(exclude)${path}`)
  const history = count(options.history, 10)
  const maxFileChars = count(options.max_file_chars, 12_000)
  const scope = ['--', '.', ...excludes]

  on('session.start', async ($, e, next) => {
    // Offer the command only where it can work: inside a git work tree. A skill of the same name already lists it.
    if (!(await isRepo($))) return next(e)
    const taken = (await $.command.list().catch(() => [])).some(command => command.name === COMMAND)
    if (taken) return next(e)

    await $.command.register({
      name: COMMAND,
      description: 'Draft a commit message for the staged changes, then commit or amend',
      argumentHint: '[hint for the drafter]',
    })
    return next(e)
  })

  on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) => {
    const questions = (e as { questions?: Question[] }).questions
    return preview && Array.isArray(questions) ? next({ ...e, questions: withPreview(questions, preview) } as typeof e) : next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    // Outside a git repo the name belongs to whatever else serves it (a skill), or says it is unknown.
    if (!(await isRepo($))) return next({ ...e, args: e.args ?? '' })
    const hint = (e.args ?? '').trim()
    const root = await $.session.root()
    const top = (await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: root })).stdout.trim() || root
    const run = (...args: string[]) => $.process.run(['git', ...args], { cwd: top })
    const git = async (...args: string[]) => (await run(...args)).stdout

    let stat = await git('diff', '--cached', '--stat', ...scope)
    let stagedNote = ''
    if (stat.trim() === '') {
      const changed = (await git('status', '--short', ...scope)).split('\n').filter(line => line.length > 3)
      if (!changed.length) return { text: 'Nothing staged, and no changes to stage.' }
      // Stage all = tracked changes plus untracked files. An untracked folder that is its own repository (a
      // worktree, a clone) is listed with a trailing slash; `git add` would record it as a gitlink, so it is left out.
      const untracked = (await git('ls-files', '--others', '--exclude-standard', '-z', ...scope)).split('\0').filter(Boolean)
      const files = untracked.filter(path => !path.endsWith('/'))
      const repos = untracked.filter(path => path.endsWith('/'))
      // `status` folds an untracked folder into one line, so count tracked lines plus untracked files.
      const toStage = changed.filter(line => !line.startsWith('??')).length + files.length
      if (toStage <= 0) return { text: `Nothing staged; only nested repositories are untracked (${repos.join(', ')}).` }
      const noun = toStage === 1 ? 'change' : 'changes'
      const choice = await $.ui
        .ask(`Nothing is staged. Stage all ${toStage} ${noun}?`, { header: 'Stage', options: [STAGE_ALL, CANCEL] })
        .catch(() => '')
      if (choice !== STAGE_ALL) return { text: 'Nothing staged.' }
      const tracked = await run('add', '-u', ...scope)
      const added = files.length ? await run('add', '--', ...files) : tracked
      if (tracked.exitCode !== 0 || added.exitCode !== 0) {
        const failed = tracked.exitCode !== 0 ? tracked : added
        return { text: `commit-msg: git add failed: ${(failed.stderr || failed.stdout).trim()}` }
      }
      stat = await git('diff', '--cached', '--stat', ...scope)
      if (stat.trim() === '') return { text: 'Nothing staged.' }
      stagedNote = `Staged all changes${repos.length ? `, leaving out the nested repositories ${repos.join(', ')}` : ''}.`
    }

    let format = ''
    let formatFile = ''
    for (const path of formatFiles) {
      format = await $.fs.read(`${top}/${path}`).catch(() => '')
      if (format.trim()) {
        formatFile = path
        break
      }
    }

    const [diff, log, status] = await Promise.all([
      git('diff', '--cached', ...scope),
      // Three times as many as needed, so enough remain once the release commits are dropped.
      history > 0 ? git('log', `-${history * 3}`, '--decorate-refs=refs/tags', LOG_FORMAT) : Promise.resolve(''),
      git('status', '--short', ...scope),
    ])

    const files = diff.split(/^(?=diff --git )/m)
    const cutCount = files.filter(file => file.length > maxFileChars).length
    const capped = files
      .map(file => (file.length > maxFileChars ? `${file.slice(0, maxFileChars)}\n[... ${file.length - maxFileChars} more characters of this file cut]\n` : file))
      .join('')

    const rules = format ? `<format_rules>\n${format}\n</format_rules>` : ''
    const recent = recentMessages(log, history)
    const prompt = [
      rules,
      recent ? `<recent_messages>\n${recent}\n</recent_messages>` : '',
      `<stat>\n${stat}\n</stat>`,
      `<diff>\n${capped}\n</diff>`,
      hint ? `<hint>\n${hint}\n</hint>` : '',
    ]
      .filter(Boolean)
      .join('\n\n')

    $.ui.status('commit-msg: drafting...')
    const reply = await $.model.complete({ model, system: SYSTEM, prompt, maxTokens: 2048, timeoutMs: 120_000 })
    $.ui.status(undefined)

    if (!reply.isAnswered) return { text: `commit-msg: model gave no answer (${reply.reason}).` }

    // Partly staged (MM), unstaged and untracked files stay out of the message; list them for the person to decide.
    const leftOut = status
      .split('\n')
      .filter(line => line.length > 3 && line[1] !== ' ')
      .map(line => `  ${line}`)

    const notes = [
      stagedNote,
      formatFiles.length && !format ? `Note: no format file found (${formatFiles.join(', ')}), drafted from the recent commits' style.` : '',
      cutCount ? `Note: ${cutCount} file diff(s) cut at ${maxFileChars} characters each.` : '',
      leftOut.length ? `Not staged (left out of the message):\n${leftOut.join('\n')}` : '',
    ].filter(Boolean)

    // The engine prefixes the row with "commit-msg: ", so a lead line keeps the fence at a line start.
    const source = formatFile ? `the staged diff, by ${formatFile}` : 'the staged diff'
    const draft = [`Draft from ${source}:`, reply.text.trim(), ...notes].join('\n\n')
    const message = fenced(reply.text)
    if (!message) return { text: draft }

    const hasHead = (await run('rev-parse', '--verify', '-q', 'HEAD')).exitCode === 0
    const isPushed = hasHead && (await git('branch', '-r', '--contains', 'HEAD')).trim() !== ''
    const previous = hasHead ? (await git('log', '-1', '--format=%B')).trim() : ''

    // The dialog shows the draft as its options' preview and runs inside this dispatch: a dialog opened from a timer
    // after the command has ended queues its notices after the turn, and an SSH session never takes them off the
    // queue. The output row is markdown, so the draft keeps its fence and line breaks there, above the outcome.
    const outcome = await decide($, { top, model, rules, message, previous, hasHead, isPushed })
    return { text: `${draft}\n\n${outcome}` }
  }).catch(($, e, next) => {
    $.ui.status(undefined)
    return next.called ? next(e) : { text: 'commit-msg: failed, see claude --debug for the reason.' }
  })
}
