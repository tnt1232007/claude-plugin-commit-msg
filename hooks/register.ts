import type { EngineInterface, Register } from 'claude-code'

// A project skill or command of the same name may exist (one shared with another agent): the command.run hook
// answers before it, so /commit-msg runs this plugin in a git repo and the skill is left to everything else.
const COMMAND = 'commit-msg'

const SYSTEM = `You write one git commit message for the staged changes of a repository.
- When the user message gives format rules, follow them exactly.
- Without them, match the style of the recent messages: their subject prefix scheme (Conventional Commits, [AREA] tags, none), subject length, whether there is a body, and its wrapping.
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
const QUESTION = 'Commit the staged changes with this message?'

const fenced = (text: string) => text.match(/```[^\n]*\n([\s\S]*?)\n```/)?.[1]?.trim()
const list = (value: unknown) =>
  (Array.isArray(value) ? value.map(String) : String(value ?? '').split(','))
    .map(item => item.trim())
    .filter(Boolean)
const count = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback)

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

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    // Outside a git repo the name belongs to whatever else serves it (a skill), or says it is unknown.
    if (!(await isRepo($))) return next({ ...e, args: e.args ?? '' })
    const hint = (e.args ?? '').trim()
    const root = await $.session.root()
    const top = (await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: root })).stdout.trim() || root
    const run = (...args: string[]) => $.process.run(['git', ...args], { cwd: top })
    const git = async (...args: string[]) => (await run(...args)).stdout

    const stat = await git('diff', '--cached', '--stat', ...scope)
    if (stat.trim() === '') return { text: 'Nothing staged.' }

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
      history > 0 ? git('log', `-${history}`, '--format=%B---') : Promise.resolve(''),
      git('status', '--short', ...scope),
    ])

    const files = diff.split(/^(?=diff --git )/m)
    const cutCount = files.filter(file => file.length > maxFileChars).length
    const capped = files
      .map(file => (file.length > maxFileChars ? `${file.slice(0, maxFileChars)}\n[... ${file.length - maxFileChars} more characters of this file cut]\n` : file))
      .join('')

    const rules = format ? `<format_rules>\n${format}\n</format_rules>` : ''
    const prompt = [
      rules,
      log.trim() ? `<recent_messages>\n${log}\n</recent_messages>` : '',
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
      formatFiles.length && !format ? `Note: no format file found (${formatFiles.join(', ')}), drafted from the recent commits' style.` : '',
      cutCount ? `Note: ${cutCount} file diff(s) cut at ${maxFileChars} characters each.` : '',
      leftOut.length ? `Not staged (left out of the message):\n${leftOut.join('\n')}` : '',
    ].filter(Boolean)

    // The engine prefixes the row with "commit-msg: ", so a lead line keeps the fence at a line start.
    const source = formatFile ? `the staged diff, by ${formatFile}` : 'the staged diff'
    const draft = [`Draft from ${source}:`, reply.text.trim(), ...notes].join('\n\n')
    const message = fenced(reply.text)
    if (!message) return { text: draft }

    // $.ui.ask has no option previews (a plugin's own AskUserQuestion tool call is refused), so the draft rides in the question. Nothing here ever pushes.
    const hasHead = (await run('rev-parse', '--verify', '-q', 'HEAD')).exitCode === 0
    const isPushed = hasHead && (await git('branch', '-r', '--contains', 'HEAD')).trim() !== ''
    const previous = hasHead ? (await git('log', '-1', '--format=%B')).trim() : ''
    const amendLabel = isPushed ? `${AMEND} (HEAD is pushed)` : AMEND
    const labels = [COMMIT, ...(hasHead ? [amendLabel] : []), LEAVE]
    // Dismissed, or no one to ask (a -p run): commit nothing.
    const choice = await $.ui.ask(`${QUESTION}\n\n${message}`, { header: 'Commit', options: labels }).catch(() => '')

    let final = message
    const args = ['commit', '-F', '-']
    if (choice === amendLabel) {
      $.ui.status('commit-msg: merging into the previous message...')
      const merged = await $.model.complete({
        model,
        system: MERGE_SYSTEM,
        prompt: [rules, `<previous_message>\n${previous}\n</previous_message>`, `<new_message>\n${message}\n</new_message>`].filter(Boolean).join('\n\n'),
        maxTokens: 2048,
        timeoutMs: 120_000,
      })
      $.ui.status(undefined)
      const mergedMessage = merged.isAnswered ? fenced(merged.text) : undefined
      if (!mergedMessage) return { text: `Not amended: the model gave no merged message${merged.isAnswered ? '' : ` (${merged.reason})`}. Changes left staged.` }
      final = mergedMessage
      args.push('--amend')
    } else if (choice !== COMMIT) {
      return { text: `${draft}\n\nLeft staged, nothing committed.` }
    }

    const result = await $.process.run(['git', ...args], { cwd: top, stdin: `${final}\n` })
    if (result.exitCode !== 0) return { text: `git ${args.join(' ')} failed:\n${(result.stderr || result.stdout).trim()}` }
    const sha = (await git('rev-parse', '--short', 'HEAD')).trim()
    const verb = args.includes('--amend') ? 'Amended' : 'Committed'
    return { text: `${verb} ${sha}, not pushed:\n\n\`\`\`\n${final}\n\`\`\`` }
  }).catch(($, e, next) => {
    $.ui.status(undefined)
    return next.called ? next(e) : { text: 'commit-msg: failed, see claude --debug for the reason.' }
  })
}
