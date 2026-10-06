import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
for (const dir of ['lambda_function', 'tests', 'scripts', 'examples']) {
  for (const file of await readdir(dir)) {
    if (/\.(m?js)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', `${dir}/${file}`], { stdio: 'inherit' });
      if (result.status) process.exit(result.status);
    }
  }
}
for (const file of ['openapi.yaml', '.github/workflows/ci.yml', '.github/workflows/deploy.yml']) YAML.parse(await readFile(file, 'utf8'));
console.log('JavaScript syntax and YAML checks passed');
