import { expect, test } from 'claude-code/testing'

type On = Parameters<Parameters<typeof test>[1]>[1]
type Repo = {
  isRepo?: boolean
  // Another command already listed under the same name (a project skill).
  skill?: boolean
  stat?: string
  log?: string
  status?: string
  pushed?: boolean
  previous?: string
  files?: Record<string, string>
  choice?: string
  replies?: string[]
}

const ROOT = 'D:/repo/sub'
const TOP = 'D:/repo'
const QUESTION = 'Commit the staged changes with this message?'
const DRAFT = '```\nfeat(api): add the health endpoint\n```\nDropped the lockfile bump as noise.'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// A git repo, a model and the commit dialog in memory; every call is recorded.
function world(on: On, repo: Repo = {}) {
  const runs: { argv: string[]; cwd?: string; stdin?: string }[] = []
  const prompts: { system?: string; prompt: string; model: string }[] = []
  const registered: string[] = []
  const asked: string[] = []
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
  on('ui.log', () => ({ value: undefined }))
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
  // $.ui.ask raises AskUserQuestion here; the draft rides in the question text.
  on('tool.call', (_, e) => {
    const question = String((e as { questions?: { question: string }[] }).questions?.[0]?.question ?? '')
    asked.push(question)
    return { result: { answers: { [question]: repo.choice ?? 'Leave staged' } } } as never
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    runs.push({ argv, cwd: e.init?.cwd, stdin: e.init?.stdin })
    const args = argv.slice(1).join(' ')
    if (args === 'rev-parse --is-inside-work-tree') return repo.isRepo === false ? out('', 128) : out('true\n')
    if (args === 'rev-parse --show-toplevel') return out(`${TOP}\n`)
    if (args.startsWith('diff --cached --stat')) return out(repo.stat ?? ' api/health.ts | 12 ++++\n')
    if (args.startsWith('diff --cached')) return out('diff --git a/api/health.ts b/api/health.ts\n+export const health = () => "ok"\n')
    if (args.startsWith('log -1')) return out(`${repo.previous ?? 'fix(api): handle timeouts'}\n`)
    if (args.startsWith('log -')) return out(repo.log ?? 'fix(api): handle timeouts\n---\n')
    if (args.startsWith('status --short')) return out(repo.status ?? 'M  api/health.ts\n')
    if (args === 'rev-parse --verify -q HEAD') return out('abc\n')
    if (args === 'branch -r --contains HEAD') return out(repo.pushed ? '  origin/main\n' : '')
    if (args === 'rev-parse --short HEAD') return out('abc1234\n')
    if (argv[1] === 'commit') return out('')
    return out('', 1)
  })
  return { runs, prompts, registered, asked }
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

test('nothing staged commits nothing', async ($, on) => {
  const { runs, prompts } = world(on, { stat: '' })
  await start($)
  const r = await $.command.run({ command: 'commit-msg' })
  expect(r.text).toBe('Nothing staged.')
  expect(prompts.length).toBe(0)
  expect(commits(runs).length).toBe(0)
})

test(
  'follows the first format file that exists, honours excludes and commits from the repo top',
  { options: { format_files: 'missing.md, docs/commit.md', exclude: '.idea, dist', model: 'haiku', history: 3 } },
  async ($, on) => {
    const { runs, prompts, asked } = world(on, { files: { [`${TOP}/docs/commit.md`]: 'Use Conventional Commits.' }, choice: 'Commit' })
    await start($)
    const r = await $.command.run({ command: 'commit-msg', args: 'mention the endpoint' })
    expect(asked[0]).toBe(`${QUESTION}\n\nfeat(api): add the health endpoint`)

    expect(prompts[0]!.model).toBe('haiku')
    expect(prompts[0]!.prompt).toContain('<format_rules>\nUse Conventional Commits.\n</format_rules>')
    expect(prompts[0]!.prompt).toContain('<hint>\nmention the endpoint\n</hint>')
    const diff = runs.find(run => run.argv.slice(1, 3).join(' ') === 'diff --cached')!
    expect(diff.argv).toContain(':(exclude).idea')
    expect(diff.argv).toContain(':(exclude)dist')
    expect(runs.some(run => run.argv.join(' ') === 'git log -3 --format=%B---')).toBe(true)

    const [commit] = commits(runs)
    expect(commit!.argv).toEqual(['git', 'commit', '-F', '-'])
    expect(commit!.cwd).toBe(TOP)
    expect(commit!.stdin).toBe('feat(api): add the health endpoint\n')
    expect(r.text).toContain('Committed abc1234, not pushed')
  },
)

test('without a format file it drafts from history, notes it, and leaves the changes staged', async ($, on) => {
  const { runs, prompts } = world(on, { status: 'M  api/health.ts\nMM api/db.ts\n?? notes.txt\n' })
  await start($)
  const r = await $.command.run({ command: 'commit-msg' })

  expect(prompts[0]!.prompt).not.toContain('<format_rules>')
  expect(prompts[0]!.prompt).toContain('<recent_messages>\nfix(api): handle timeouts')
  expect(r.text).toContain('no format file found (.claude/commit-format.md, .github/commit-format.md)')
  expect(r.text).toContain('Not staged (left out of the message):\n  MM api/db.ts\n  ?? notes.txt')
  expect(r.text).not.toContain('api/health.ts\n')
  expect(r.text).toContain('Left staged, nothing committed.')
  expect(commits(runs).length).toBe(0)
})

test('amend merges the draft into HEAD and warns when HEAD is pushed', async ($, on) => {
  const merged = '```\nfix(api): handle timeouts, add the health endpoint\n```'
  const { runs, prompts } = world(on, { pushed: true, choice: 'Amend (HEAD is pushed)', replies: [DRAFT, merged] })
  await start($)
  const r = await $.command.run({ command: 'commit-msg' })

  expect(prompts.length).toBe(2)
  expect(prompts[1]!.prompt).toContain('<previous_message>\nfix(api): handle timeouts\n</previous_message>')
  const [commit] = commits(runs)
  expect(commit!.argv).toEqual(['git', 'commit', '-F', '-', '--amend'])
  expect(commit!.stdin).toBe('fix(api): handle timeouts, add the health endpoint\n')
  expect(r.text).toContain('Amended abc1234, not pushed')
})
