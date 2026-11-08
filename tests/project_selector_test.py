"""Acceptance tests for the public project-selector command, using real Git repos."""
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class ProjectSelectorTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='project-selector-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.projects = self.root / 'projects with spaces'
        self.projects.mkdir()
        self.bin = self.root / 'mock-bin'
        self.bin.mkdir()
        self.args = self.root / 'fzf-args'
        self.rows = self.root / 'fzf-rows'
        # Exercise the actual selector pipeline and preserve all its fzf args.
        # This fixture emulates fzf's requested accept-nth field and cancellation.
        fzf = self.bin / 'fzf'
        fzf.write_text('''#!/bin/bash
printf '%s\\0' "$@" > "$FZF_ARGS_FILE"
: > "$FZF_ROWS_FILE"
selected=''
while IFS= read -r row; do
  printf '%s\\n' "$row" >> "$FZF_ROWS_FILE"
  if [[ -z "$selected" ]]; then selected="${row%%$'\\t'*}"; fi
done
[[ "${FZF_TEST_CANCEL:-0}" = 0 ]] || exit 130
[[ -z "$selected" ]] || printf '%s\\n' "$selected"
''')
        fzf.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.bin) + ':/usr/bin:/bin',
                        HOME=str(self.root / 'home'), XDG_CONFIG_HOME=str(self.root / 'config'),
                        PROJECTS_DIR=str(self.projects), FZF_ARGS_FILE=str(self.args),
                        FZF_ROWS_FILE=str(self.rows), GIT_CONFIG_GLOBAL='/dev/null',
                        GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0')
        pathlib.Path(self.env['HOME']).mkdir()

    def git(self, *args):
        return subprocess.run(['/usr/bin/git', *map(str, args)], env=self.env,
                              capture_output=True, text=True, check=True, timeout=10)

    def repository(self, path):
        path.mkdir(parents=True, exist_ok=True)
        self.git('init', '-q', path)
        self.git('-C', path, '-c', 'user.name=Selector fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '--allow-empty', '-qm', 'Initial fixture')
        return path

    def selector(self, *args, cancel=False):
        env = dict(self.env, FZF_TEST_CANCEL='1' if cancel else '0')
        result = subprocess.run([str(ROOT / 'bin/project-selector'), *args], env=env,
                                capture_output=True, text=True, timeout=10)
        rows = self.rows.read_text().splitlines() if self.rows.exists() else []
        return result, dict(row.split('\t', 1) for row in rows)

    def test_ordinary_repository_and_concise_display(self):
        repo = self.repository(self.projects / 'team' / 'ordinary')
        result, rows = self.selector()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(rows, {str(repo): 'team/ordinary'})
        self.assertEqual(result.stdout, str(repo) + '\n')

    def test_valid_linked_worktree_is_selectable_alongside_repository(self):
        repo = self.repository(self.projects / 'team' / 'primary')
        worktree = self.projects / 'team' / 'linked'
        self.git('-C', repo, 'worktree', 'add', '-q', '-b', 'linked-fixture', worktree)
        self.assertTrue((worktree / '.git').is_file())
        result, rows = self.selector()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(rows), {str(repo), str(worktree)})
        self.assertEqual(rows[str(worktree)], 'team/linked')

    def test_paths_with_spaces_and_fzf_arguments_are_preserved(self):
        repo = self.repository(self.projects / 'my team' / 'main repo')
        worktree = self.projects / 'my team' / 'linked repo'
        self.git('-C', repo, 'worktree', 'add', '-q', '-b', 'space-fixture', worktree)
        result, rows = self.selector('--query', 'main repo', '--prompt=Choose a project: ')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(rows), {str(repo), str(worktree)})
        args = self.args.read_bytes().decode().split('\0')[:-1]
        self.assertEqual(args[-3:], ['--query', 'main repo', '--prompt=Choose a project: '])
        for arg in ['--scheme=path', '--with-nth=2', '--accept-nth=1', '--border=none', '--preview-window=hidden']:
            self.assertIn(arg, args)
        self.assertIn(result.stdout.rstrip('\n'), rows)

    def test_empty_and_malformed_git_directories_are_not_projects(self):
        repo = self.repository(self.projects / 'team' / 'real')
        for name in ['empty directory marker', 'malformed directory marker']:
            marker = self.projects / 'team' / name / '.git'
            marker.mkdir(parents=True)
            if name.startswith('malformed'):
                (marker / 'ordinary.txt').write_text('not Git metadata\n')
            self.assertTrue(marker.is_dir())
        result, rows = self.selector('--query', 'real')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(rows), {str(repo)})

    def test_invalid_directory_markers_do_not_inherit_parent_repository_identity(self):
        self.repository(self.projects)
        repo = self.repository(self.projects / 'team' / 'real')
        for name in ['empty directory marker', 'malformed directory marker']:
            path = self.projects / 'team' / name
            (path / '.git').mkdir(parents=True)
            if name.startswith('malformed'):
                (path / '.git' / 'ordinary.txt').write_text('not Git metadata\n')
            inherited = self.git('-C', path, 'rev-parse', '--show-toplevel')
            self.assertEqual(inherited.stdout.strip(), str(self.projects))
        result, rows = self.selector()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(rows), {str(repo)})

    def test_malformed_and_dangling_git_files_are_not_projects(self):
        repo = self.repository(self.projects / 'team' / 'real')
        for name, marker in [('plain-file', 'ordinary text\n'), ('dangling', 'gitdir: /nonexistent/selector-fixture\n')]:
            path = self.projects / 'team' / name
            path.mkdir()
            (path / '.git').write_text(marker)
        result, rows = self.selector()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(rows), {str(repo)})

    def test_scan_depth_is_bounded_and_git_metadata_is_not_recursed(self):
        repo = self.repository(self.projects / 'team' / 'visible')
        self.repository(self.projects / 'too' / 'deep' / 'hidden')
        self.repository(self.projects)
        result, rows = self.selector()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(rows), {str(repo)})

    def test_live_scan_finds_repository_added_after_first_selection(self):
        first = self.repository(self.projects / 'team' / 'first')
        _, before = self.selector()
        second = self.repository(self.projects / 'team' / 'second')
        _, after = self.selector()
        self.assertEqual(set(before), {str(first)})
        self.assertEqual(set(after), {str(first), str(second)})

    def test_fzf_cancellation_has_no_selection_and_changes_no_repository(self):
        repo = self.repository(self.projects / 'team' / 'ordinary')
        before = self.git('-C', repo, 'rev-parse', 'HEAD').stdout
        result, rows = self.selector(cancel=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertEqual(set(rows), {str(repo)})
        self.assertEqual(self.git('-C', repo, 'rev-parse', 'HEAD').stdout, before)

    def test_missing_projects_directory_produces_no_selection(self):
        shutil.rmtree(self.projects)
        result, rows = self.selector()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertEqual(rows, {})


if __name__ == '__main__':
    unittest.main()
