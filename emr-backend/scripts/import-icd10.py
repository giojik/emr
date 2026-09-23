#!/usr/bin/env python3
"""
ICD-10 (ქართული) → SQL migration.
  python3 scripts/import-icd10.py data/icd10/icd10_ka_source.txt migrations/0005_icd10_data.sql data/icd10/review_needed.csv

წყარო: TSV (Код / Наименование / ...), UTF-8 BOM, CRLF.
 - მრავალხაზიანი ჩანაწერები წინა კოდს უერთდება და needs_review-ით ინიშნება
 - სათაურის ბოლოს "(A00.0)" იშლება
 - "*" → is_asterisk (მანიფესტაციის კოდი — ძირითად დიაგნოზად დაუშვებელია), "+"/"†" → is_dagger
 - "კლასი N" → თავების (chapters) სათაურები
"""
import csv, re, sys

CODE_RE = re.compile(r'^\*?([A-Z]\d\d(?:\.\d{1,2})?)\.?([*+†]?)$')
CHAPTERS = [(1,'A00','B99'),(2,'C00','D48'),(3,'D50','D89'),(4,'E00','E90'),(5,'F00','F99'),(6,'G00','G99'),
            (7,'H00','H59'),(8,'H60','H95'),(9,'I00','I99'),(10,'J00','J99'),(11,'K00','K93'),(12,'L00','L99'),
            (13,'M00','M99'),(14,'N00','N99'),(15,'O00','O99'),(16,'P00','P96'),(17,'Q00','Q99'),(18,'R00','R99'),
            (19,'S00','T98'),(20,'V01','Y98'),(21,'Z00','Z99'),(22,'U00','U99')]

def chapter_of(code):
    cat = code[:3]
    for n, a, b in CHAPTERS:
        if a <= cat <= b: return n
    return None

def q(s): return "'" + s.replace("'", "''") + "'"

def parse(path):
    lines = [l.rstrip('\r\n') for l in open(path, encoding='utf-8-sig')][1:]
    recs, classes, stats = [], {}, {'continuation': 0, 'empty_title': 0, 'duplicate': 0, 'block': 0}
    for l in lines:
        parts = l.split('\t'); head = parts[0].strip()
        if head.startswith('კლასი') and len(parts) >= 2:
            classes[int(head.split()[1])] = parts[1].strip(); continue
        m = CODE_RE.match(head.replace('*.', '.').replace('.*', '*')) if len(parts) >= 2 else None
        if m:
            recs.append({'code': m.group(1), 'mark': m.group(2), 'title': parts[1].strip(), 'merged': False})
        elif re.fullmatch(r'[A-Z]\d\d-[A-Z]\d\d', head):
            stats['block'] += 1
        elif recs:
            recs[-1]['title'] += ' ' + head; recs[-1]['merged'] = True; stats['continuation'] += 1
    out = {}
    for r in recs:
        c = r['code']
        t = re.sub(r'\s+', ' ', r['title'])
        t = re.sub(r'\s*\(\s*\*?' + re.escape(c) + r'\s*\.?[*+†]?\s*\)\s*$', '', t).strip()
        dagger = r['mark'] in ('+', '†')
        if t.startswith('†'): dagger, t = True, t.lstrip('† ').strip()
        if not t: stats['empty_title'] += 1; continue
        if c in out: stats['duplicate'] += 1; continue
        review = r['merged'] or t.count('(') != t.count(')')
        out[c] = dict(code=c, title=t, chapter=chapter_of(c), asterisk=r['mark'] == '*', dagger=dagger, review=review)
    return out, classes, stats

def main(src, dst, review_csv=None):
    codes, classes, stats = parse(src)
    with open(dst, 'w', encoding='utf-8') as f:
        f.write('-- ' + dst.split('/')[-1] + '\n-- ავტოგენერირებულია scripts/import-icd10.py-ით. ხელით არ შეცვალოთ —\n'
                '-- შესწორებები ახალი migration-ით (UPDATE icd10_codes ...).\n\n')
        f.write('INSERT INTO icd10_chapters (id, title, code_from, code_to) VALUES\n')
        f.write(',\n'.join(f"  ({n}, {q(classes.get(n, ''))}, '{a}', '{b}')" for n, a, b in CHAPTERS) + ';\n\n')
        items = sorted(codes.values(), key=lambda v: v['code'])
        for i in range(0, len(items), 1000):
            chunk = items[i:i + 1000]
            f.write('INSERT INTO icd10_codes (code, title, chapter_id, is_asterisk, is_dagger, needs_review) VALUES\n')
            f.write(',\n'.join(
                f"  ('{v['code']}', {q(v['title'])}, {v['chapter'] or 'NULL'}, {str(v['asterisk']).upper()}, "
                f"{str(v['dagger']).upper()}, {str(v['review']).upper()})" for v in chunk) + ';\n\n')
        f.write('-- დიაგნოზები მხოლოდ კლასიფიკატორიდან\n'
                'ALTER TABLE encounter_diagnoses ADD CONSTRAINT fk_encounter_diagnoses_icd10\n'
                '    FOREIGN KEY (icd10_code) REFERENCES icd10_codes(code);\n'
                'ALTER TABLE patient_chronic_conditions ADD CONSTRAINT fk_chronic_conditions_icd10\n'
                '    FOREIGN KEY (icd10_code) REFERENCES icd10_codes(code);\n')
    if review_csv:
        with open(review_csv, 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.writer(f); w.writerow(['code', 'title', 'reason'])
            for v in sorted(codes.values(), key=lambda v: v['code']):
                if v['review']: w.writerow([v['code'], v['title'], 'მრავალხაზიანი/შეწყვეტილი ტექსტი წყაროში'])
    print(f"codes={len(codes)} review={sum(v['review'] for v in codes.values())} "
          f"asterisk={sum(v['asterisk'] for v in codes.values())} dagger={sum(v['dagger'] for v in codes.values())} {stats}")

if __name__ == '__main__':
    main(*sys.argv[1:])
