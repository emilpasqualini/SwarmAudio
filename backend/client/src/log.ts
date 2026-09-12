//
//  log.ts
//  HIVE (client)
//
//  The running strip along the bottom of the page — taken from SCSS_web.
//  Connection events are invisible otherwise, and "it fell back to POST" is
//  exactly the line someone will need to read off a phone at the venue.
//

export type LogKind = 'plain' | 'step' | 'warn' | 'fail';

export class ActivityLog {
  private readonly lines: { text: string; kind: LogKind }[] = [];
  static readonly visible = 5;

  constructor(private readonly element: HTMLElement) {}

  log(text: string, kind: LogKind = 'plain'): void {
    this.lines.push({ text, kind });
    if (this.lines.length > 200) this.lines.shift();
    const label = kind === 'fail' ? 'error' : kind === 'warn' ? 'warn' : 'log';
    (console as unknown as Record<string, (m: string) => void>)[label]?.(`[hive] ${text}`);
    this.render();
  }

  step(text: string): void { this.log(text, 'step'); }
  warn(text: string): void { this.log(text, 'warn'); }
  fail(text: string): void { this.log(text, 'fail'); }

  private render(): void {
    const tail = this.lines.slice(-ActivityLog.visible);
    this.element.replaceChildren(
      ...tail.map(({ text, kind }) => {
        const div = document.createElement('div');
        if (kind !== 'plain') div.className = kind;
        div.textContent = text;
        return div;
      }),
    );
  }
}
