import {expect, test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {StepSourceLink, stepSourceHref} from './step-source-link';
const source = {id: 'notes', repository: 'Mentra-Community/Mentra-Automated-Testing', revision: 'a'.repeat(40), path: 'routines/notes-phone/routine.ts', line: 185};
test('GitHub icon opens the immutable file and one-based line with an accessible name', () => {
  const href = `https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/${source.revision}/${source.path}#L185`;
  expect(stepSourceHref(source)).toBe(href);
  const html = renderToStaticMarkup(<StepSourceLink source={source}/>);
  expect(html).toContain(`href="${href}"`);
  expect(html).toContain('aria-label="View this step on GitHub"');
  expect(html).toContain('<svg');
  expect(html).toContain('target="_blank"');
});
test('historical missing locations and invalid links do not produce guessed GitHub links', () => {
  for (const invalid of [undefined, {...source, revision: 'main'}, {...source, path: '../secret.ts'}, {...source, line: -1}]) {
    expect(stepSourceHref(invalid)).toBeNull();
    expect(renderToStaticMarkup(<StepSourceLink source={invalid}/>)).toBe('');
  }
});
