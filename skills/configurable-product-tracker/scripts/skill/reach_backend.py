"""Call installed agent-reach upstream tools without interpolating shell text."""
import os
from pathlib import Path
import shutil
import subprocess


def mcporter_command():
    executable = shutil.which('mcporter')
    if not executable and os.name == 'nt':
        candidate = Path(os.environ.get('APPDATA', '')) / 'npm' / 'mcporter.cmd'
        if candidate.is_file():
            executable = str(candidate)
    if not executable:
        raise RuntimeError('mcporter missing; configure agent-reach Exa backend (see references/agent-reach-setup.md)')
    if Path(executable).suffix.lower() in ('.cmd', '.ps1'):
        node = shutil.which('node')
        cli = Path(executable).parent / 'node_modules' / 'mcporter' / 'dist' / 'cli.js'
        if not node or not cli.is_file():
            raise RuntimeError('Node or mcporter CLI entry missing')
        return [node, str(cli)]
    return [executable]


def search(query):
    command = mcporter_command() + ['call', 'exa.web_search_exa', 'query=' + query, 'numResults=5']
    result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=75)
    if result.returncode or result.stdout.lstrip().startswith(('Error:', '[mcporter]')):
        raise RuntimeError((result.stderr or result.stdout or 'Search failed')[:1200])
    if not result.stdout.strip():
        raise RuntimeError('Search returned no content')
    return result.stdout
