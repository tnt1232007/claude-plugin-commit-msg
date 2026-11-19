import { expect, mock, test } from 'claude-code/testing'

type On = Parameters<Parameters<typeof test>[1]>[1]
type Repo = {
  isRepo?: boolean
  // Another command already listed under the same name (a project skill).
  skill?: boolean
  stat?: string
  // The staged stat once `git add` has run (Stage all).
  stagedStat?: string
  // `git ls-files --others -z` output: untracked files, a nested repository with a trailing slash.
  untracked?: string
  log?: string
  status?: string
  pushed?: boolean
  previous?: string
  files?: Record<string, string>
  choice?: string
  // The dialog is closed without an answer.
  dismiss?: boolean
  replies?: string[]
}

const ROOT = 'D:/repo/sub'
const TOP = 'D:/repo'
const QUESTION = 'Commit the staged changes with the drafted message?'
const DRAFT = '```\nfeat(api): add the health endpoint\n```\nDropped the lockfile bump as noise.'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// `git log --decorate-refs=refs/tags --format=%x1e%D%x1f%B` output, newest first: a commit's refs are its tag
// decorations ('tag: v1.2.0'), empty when it has none.
const log = (...commits: { message: string; refs?: string }[]) => commits.map(c => `\x1e${c.refs ?? ''}\x1f${c.message}\n`).join('')

// A git repo, a model and the commit dialog in memory; every call is recorded.
function world(on: On, repo: Repo = {}) {
  const runs: { argv: string[]; cwd?: string; stdin?: string }[] = []
  const prompts: { system?: string; prompt: string; model: string }[] = []
  const registered: string[] = []
  const asked: string[] = []
  const logs: string[] = []
  // What the person sees, in order: a logged line, a dialog, a commit.
  const order: string[] = []
  const replies = [...(repo.replies ?? [DRAFT])]
  const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('command.list', () => ({ value: repo.skill ? [{ name: 'commit-msg', description: 'skill', source: 'user' }] : [] }) as never)
  // What runs beneath the plugin: the skill, when the plugin passes the command on.
  on('command.run', () => ({ text: 'skill ran' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', (_, e) => {
    logs.push(String((e as { text?: string }).text ?? ''))
    order.push('log')
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    // The engine hands the path over in the platform's own form (backslashes on Windows).
    const text = repo.files?.[e.path.replace(/\\/g, '/')]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('model.complete', (_, e) => {
    prompts.push({ system: e.system, prompt: e.prompt, model: e.model })
    return { value: { isAnswered: true as const, text: replies.shift() ?? '', usage: USAGE } }
  })
  // $.ui.ask raises AskUserQuestion here.
  on('tool.call', (_, e) => {
    const question = String((e as { questions?: { question: string }[] }).questions?.[0]?.question ?? '')
    asked.push(question)
    order.push('ask')
    if (repo.dismiss) throw new Error('dismissed')
    return { result: { answers: { [question]: repo.choice ?? 'Leave staged' } } } as never
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    runs.push({ argv, cwd: e.init?.cwd, stdin: e.init?.stdin })
    const args = argv.slice(1).join(' ')
    if (args === 'rev-parse --is-inside-work-tree') return repo.isRepo === false ? out('', 128) : out('true\n')
    if (args === 'rev-parse --show-toplevel') return out(`${TOP}\n`)
    const isAdded = runs.some(run => run.argv[1] === 'add')
    if (args.startsWith('diff --cached --stat')) return out((isAdded ? repo.stagedStat : repo.stat) ?? ' api/health.ts | 12 ++++\n')
    if (args.startsWith('ls-files --others')) return out(repo.untracked ?? '')
    if (argv[1] === 'add') return out('')
    if (args.startsWith('diff --cached')) return out('diff --git a/api/health.ts b/api/health.ts\n+export const health = () => "ok"\n')
    if (args === 'log -1 --format=%B') return out(`${repo.previous ?? 'fix(api): handle timeouts'}\n`)
    if (args.startsWith('log -')) return out(repo.log ?? log({ message: 'fix(api): handle timeouts' }))
    if (args.startsWith('status --short')) return out(repo.status ?? 'M  api/health.ts\n')
    if (args === 'rev-parse --verify -q HEAD') return out('abc\n')
    if (args === 'branch -r --contains HEAD') return out(repo.pushed ? '  origin/main\n' : '')
    if (args === 'rev-parse --short HEAD') return out('abc1234\n')
    if (argv[1] === 'commit') {
      order.push('commit')
      return out('')
    }
    return out('', 1)
  })
  return { runs, prompts, registered, asked, logs, order }
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
const commits = (runs: { argv: string[] }[]) => runs.filter(run => run.argv[1] === 'commit')

test('offers /commit-msg only inside a git work tree', async ($, on) => {
  const { registered } = world(on, { isRepo: false })
  await start($)
  expect(registered).toEqual([])
})

test('registers /commit-msg in a git repo', async ($, on) => {
  const { registered } = world(on)
  await start($)
  expect(registered).toEqual(['commit-msg'])
})

test('a skill of the same name keeps its listing, but /commit-msg runs the plugin in a repo', async ($, on) => {
  const { registered, prompts } = world(on, { skill: true })
  await start($)
  expect(registered).toEqual([])
  const r = await $.command.run({ command: 'commit-msg' })
  expect(r.text).not.toBe('skill ran')
  expect(prompts.length).toBe(1)
})

test('outside a git repo /commit-msg falls through to the skill', async ($, on) => {
  const { prompts } = world(on, { isRepo: false, skill: true })
  await start($)
  const r = await $.command.run({ command: 'commit-msg' })
  expect(r.text).toBe('skill ran')
  expect(prompts.length).toBe(0)
})

test('nothing staged asks to stage all, and Cancel commits nothing', async ($, on) => {
  const { runs, prompts, asked } = world(on, { stat: '', status: ' M api/health.ts\n?? notes.txt\n', untracked: 'notes.txt\0', choice: 'Cancel' })
  await start($)
  const r = await $.command.run({ command: 'commit-msg' })
  expect(asked).toEqual(['Nothing is staged. Stage all 2 changes?'])
  expect(r.text).toBe('Nothing staged.')
  expect(runs.some(run => run.argv[1] === 'add')).toBe(false)
  expect(prompts.length).toBe(0)
  expect(commits(runs).length).toBe(0)
})

test('nothing staged and nothing changed does not ask', async ($, on) => {
  const { prompts, asked } = world(on, { stat: '', status: '' })
  await start($)
  const r = await $.command.run({ command: 'commit-msg' })
  expect(asked).toEqual([])
  expect(r.text).toBe('Nothing staged, and no changes to stage.')
  expect(prompts.length).toBe(0)
})

test('Stage all stages tracked changes and untracked files, but not a nested repository, then drafts', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const { runs, prompts, asked, logs } = world(on, {
    stat: '',
    stagedStat: ' api/health.ts | 12 ++++\n',
    status: ' M api/health.ts\n?? .claude/\n',
    untracked: 'notes.txt\0.claude/worktrees/app/\0',
    choice: 'Stage all',
  })
  await start($)
  const pending = $.command.run({ command: 'commit-msg' })
  await clock.advance(1000)
  await pending
  expect(asked).toEqual(['Nothing is staged. Stage all 2 changes?', QUESTION])
  const adds = runs.filter(run => run.argv[1] === 'add').map(run => run.argv.slice(1).join(' '))
  expect(adds).toEqual(['add -u -- . :(exclude).idea', 'add -- notes.txt'])
  expect(prompts.length).toBe(1)
  expect(logs[0]).toContain('Staged all changes, leaving out the nested repositories .claude/worktrees/app/.')
})

test(
  'follows the first format file that exists, honours excludes and commits from the repo top',
  { options: { format_files: 'missing.md, docs/commit.md', exclude: '.idea, dist', model: 'haiku', history: 3 } },
  async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const { runs, prompts, asked, logs, order } = world(on, { files: { [`${TOP}/docs/commit.md`]: 'Use Conventional Commits.' }, choice: 'Commit' })
    await start($)
    const pending = $.command.run({ command: 'commit-msg', args: 'mention the endpoint' })
    await clock.advance(1000)
    const r = await pending
    // The draft is logged first, then the dialog asks the short question alone, then the commit runs, all inside the
    // command's own dispatch; the command answers with the outcome.
    expect(order).toEqual(['log', 'ask', 'commit'])
    expect(logs[0]).toContain('Draft from the staged diff, by docs/commit.md:\n\n```\nfeat(api): add the health endpoint\n```')
    expect(asked).toEqual([QUESTION])
    expect(r.text).toBe('commit-msg: committed abc1234, not pushed.')

    expect(prompts[0]!.model).toBe('haiku')
    expect(prompts[0]!.prompt).toContain('<format_rules>\nUse Conventional Commits.\n</format_rules>')
    expect(prompts[0]!.prompt).toContain('<hint>\nmention the endpoint\n</hint>')
    const diff = runs.find(run => run.argv.slice(1, 3).join(' ') === 'diff --cached')!
    expect(diff.argv).toContain(':(exclude).idea')
    expect(diff.argv).toContain(':(exclude)dist')
    expect(runs.some(run => run.argv.join(' ') === 'git log -9 --decorate-refs=refs/tags --format=%x1e%D%x1f%B')).toBe(true)

    const [commit] = commits(runs)
    expect(commit!.argv).toEqual(['git', 'commit', '-F', '-'])
    expect(commit!.cwd).toBe(TOP)
    expect(commit!.stdin).toBe('feat(api): add the health endpoint\n')
    expect(logs.length).toBe(1)
  },
)

test('without a format file it drafts from history, notes it, and leaves the changes staged', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const { runs, prompts, logs, asked } = world(on, { status: 'M  api/health.ts\nMM api/db.ts\n?? notes.txt\n' })
  await start($)
  const pending = $.command.run({ command: 'commit-msg' })
  await clock.advance(1000)
  const r = await pending

  expect(prompts[0]!.prompt).not.toContain('<format_rules>')
  expect(prompts[0]!.prompt).toContain('<recent_messages>\n<message>\nfix(api): handle timeouts\n</message>\n</recent_messages>')
  expect(logs[0]).toContain('no format file found (.claude/commit-format.md, .github/commit-format.md)')
  expect(logs[0]).toContain('Not staged (left out of the message):\n  MM api/db.ts\n  ?? notes.txt')
  expect(logs[0]).not.toContain('api/health.ts\n')
  expect(asked).toEqual([QUESTION])
  expect(r.text).toBe('commit-msg: left staged, nothing committed.')
  expect(commits(runs).length).toBe(0)
})

test('a dismissed Commit dialog commits nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const { runs, asked } = world(on, { dismiss: true })
  await start($)
  const pending = $.command.run({ command: 'commit-msg' })
  await clock.advance(1000)
  const r = await pending
  expect(asked).toEqual([QUESTION])
  expect(r.text).toBe('commit-msg: left staged, nothing committed.')
  expect(commits(runs).length).toBe(0)
})

test('no fenced message from the model: the reply is the output and nothing is asked', async ($, on) => {
  const { runs, asked, logs } = world(on, { replies: ['I could not tell what changed.'] })
  await start($)
  const r = await $.command.run({ command: 'commit-msg' })
  expect(r.text).toContain('Draft from the staged diff:\n\nI could not tell what changed.')
  expect(asked).toEqual([])
  expect(logs).toEqual([])
  expect(commits(runs).length).toBe(0)
})

test('release commits (tagged) are left out of the recent messages', { options: { history: 2 } }, async ($, on) => {
  const { prompts } = world(on, {
    log: log(
      { message: 'App 2.3.3', refs: 'tag: app-v2.3.3' },
      { message: 'feat(api): add paging' },
      { message: 'App 2.3.2', refs: 'HEAD -> main, tag: app-v2.3.2' },
      { message: 'fix(db): close idle connections\n\nThe pool kept them past the timeout.' },
      { message: 'App 2.3.1', refs: 'tag: app-v2.3.1' },
      { message: 'docs: describe the settings' },
    ),
  })
  await start($)
  await $.command.run({ command: 'commit-msg' })

  const prompt = prompts[0]!.prompt
  expect(prompt).toContain(
    '<recent_messages>\n<message>\nfeat(api): add paging\n</message>\n<message>\nfix(db): close idle connections\n\nThe pool kept them past the timeout.\n</message>\n</recent_messages>',
  )
  expect(prompt).not.toContain('App 2.3')
  expect(prompt).not.toContain('docs: describe the settings')
  expect(prompt).not.toContain('---')
})

test('when every recent commit is tagged, they are kept', async ($, on) => {
  const { prompts } = world(on, {
    log: log({ message: 'App 2.3.3', refs: 'tag: app-v2.3.3' }, { message: 'App 2.3.2', refs: 'tag: app-v2.3.2' }),
  })
  await start($)
  await $.command.run({ command: 'commit-msg' })
  expect(prompts[0]!.prompt).toContain('<recent_messages>\n<message>\nApp 2.3.3\n</message>\n<message>\nApp 2.3.2\n</message>\n</recent_messages>')
})

test('amend merges the draft into HEAD and warns when HEAD is pushed', async ($, on) => {
  const merged = '```\nfix(api): handle timeouts, add the health endpoint\n```'
  const clock = mock.clock(on, { now: 0 })
  const { runs, prompts, order } = world(on, { pushed: true, choice: 'Amend (HEAD is pushed)', replies: [DRAFT, merged] })
  await start($)
  const pending = $.command.run({ command: 'commit-msg' })
  await clock.advance(1000)
  const r = await pending

  expect(prompts.length).toBe(2)
  expect(prompts[1]!.prompt).toContain('<previous_message>\nfix(api): handle timeouts\n</previous_message>')
  const [commit] = commits(runs)
  expect(commit!.argv).toEqual(['git', 'commit', '-F', '-', '--amend'])
  expect(commit!.stdin).toBe('fix(api): handle timeouts, add the health endpoint\n')
  expect(order).toEqual(['log', 'ask', 'commit'])
  expect(r.text).toBe("commit-msg: amended abc1234 (draft merged into HEAD's message), not pushed.")
})
