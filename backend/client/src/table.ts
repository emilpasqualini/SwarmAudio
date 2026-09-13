//
//  table.ts
//  HIVE (client, dashboard)
//
//  Table headers you can click to sort by.
//
//  Two shapes, because the dashboard has two kinds of table. The protocol
//  tables are static, so `SortableTable` owns its rows and rebuilds the body
//  whenever the order changes. The swarm table is repainted ten times a second
//  into rows that keep their own bar elements, so there only the *order* comes
//  from here (`Sorter.sort`) and the caller re-appends its existing rows —
//  appending a node that is already in place is a no-op in the DOM, so a
//  steady order costs nothing.
//
//  Clicking the column that is already sorted turns the order around. Numeric
//  columns start descending: on this page the interesting question is who
//  moves the most, not who moves the least.
//

import { el } from './dom';

export interface Column<T> {
  label: string;
  /** Sort key. A column without one is not sortable (the buttons column). */
  value?: (row: T) => string | number;
  /** Sort descending on the first click. */
  desc?: boolean;
  /** Extra class for the header cell. */
  class?: string;
}

/**
 * Sort key for a cell with nothing in it. U+FFFF collates after every letter,
 * so the blanks gather at the bottom instead of on top of the first row.
 */
export const SORT_LAST = String.fromCharCode(0xffff);

/** Numbers numerically, text case-insensitively and with embedded numbers in order. */
const compare = (a: string | number, b: string | number): number =>
  typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });

/** The header row and the ordering it stands for. */
export class Sorter<T> {
  readonly thead: HTMLTableSectionElement;
  private readonly arrows: HTMLElement[] = [];
  private index: number;
  private dir: 1 | -1 = 1;

  /** `initial` is the column sorted on load, or −1 for the natural order. */
  constructor(
    private readonly columns: Column<T>[],
    private readonly onChange: () => void,
    initial = -1,
  ) {
    this.index = initial;
    this.thead = el('thead', {}, el('tr', {}, ...columns.map((c, i) => this.header(c, i))));
    this.paint();
  }

  /** A sorted copy; the input order while no sortable column is chosen. */
  sort(rows: readonly T[]): T[] {
    const value = this.columns[this.index]?.value;
    if (!value) return [...rows];
    return rows
      .map((row, i) => ({ row, i, key: value(row) }))
      // The index tiebreak keeps the sort stable, so rows with equal keys do
      // not swap places on every repaint.
      .sort((a, b) => compare(a.key, b.key) * this.dir || a.i - b.i)
      .map((x) => x.row);
  }

  private header(column: Column<T>, i: number): HTMLElement {
    const arrow = el('span', { class: 'arrow' });
    this.arrows[i] = arrow;
    if (!column.value) return el('th', { class: column.class ?? '' }, column.label);
    const th = el('th', {
      class: `sortable ${column.class ?? ''}`.trim(),
      role: 'button', tabindex: '0', title: `sort by ${column.label}`,
    }, column.label, arrow);
    th.onclick = () => this.choose(i);
    th.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      this.choose(i);
    };
    return th;
  }

  private choose(i: number): void {
    if (this.index === i) this.dir = this.dir === 1 ? -1 : 1;
    else { this.index = i; this.dir = this.columns[i]!.desc ? -1 : 1; }
    this.paint();
    this.onChange();
  }

  private paint(): void {
    this.arrows.forEach((arrow, i) => {
      const on = i === this.index;
      arrow.textContent = on ? (this.dir === 1 ? ' ↑' : ' ↓') : '';
      arrow.parentElement?.setAttribute('aria-sort', on ? (this.dir === 1 ? 'ascending' : 'descending') : 'none');
    });
  }
}

/**
 * A whole table for rows that do not change on their own: give it the columns
 * and how to draw one row, and it rebuilds itself when a header is clicked.
 */
export class SortableTable<T> {
  readonly element: HTMLTableElement;
  private readonly body = el('tbody');
  private readonly sorter: Sorter<T>;
  private rows: readonly T[] = [];

  constructor(
    columns: Column<T>[],
    private readonly row: (item: T) => HTMLTableRowElement,
    tableClass = '',
  ) {
    this.sorter = new Sorter(columns, () => this.paint());
    this.element = el('table', { class: tableClass }, this.sorter.thead, this.body);
  }

  setRows(rows: readonly T[]): void {
    this.rows = rows;
    this.paint();
  }

  private paint(): void {
    this.body.replaceChildren(...this.sorter.sort(this.rows).map(this.row));
  }
}
