#!/usr/bin/env python3
"""Turn the church's membership spreadsheet (.xlsx) into import files.

Uses only the Python standard library, so nothing needs installing.

  python scripts/import_members.py "C:/path/to/Membership.xlsx"            # report only
  python scripts/import_members.py "C:/path/to/Membership.xlsx" --write    # also write files

Files are written to a folder OUTSIDE the project (default: ~/Downloads/CBC-import)
so personal details can never be committed to GitHub or published with the site.

Options:
  --out FOLDER     where to write the files
  --address        also keep the home address (left out by default, to collect only what is needed)
  --church-id ID   put your church id into the SQL file for you
  --local          also add the members to the local demo server data (data/members.json)

Expected columns (any order, case does not matter): NAME, SURNAME, CONTACT NO., EMAIL ADDRESS, HOME ADDRESS
Nothing printed by the report contains a member's details, only row numbers and counts.
"""
import argparse
import csv
import json
import os
import re
import sys
import uuid
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


# ---------- reading the workbook (standard library only) ----------

def _col_index(ref):
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def read_first_sheet(path):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels")).findall(REL + "Relationship")}
    first = wb.find("m:sheets", NS).findall("m:sheet", NS)[0]
    target = rels[first.get("{%s}id" % NS["r"])].lstrip("/")
    sheet = ET.fromstring(z.read(target if target.startswith("xl/") else "xl/" + target))
    rows = []
    for row in sheet.iter("{%s}row" % NS["m"]):
        cells = {}
        for c in row.findall("m:c", NS):
            v = c.find("m:v", NS)
            t = c.get("t")
            if t == "s" and v is not None:
                val = shared[int(v.text)]
            elif t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter("{%s}t" % NS["m"]))
            else:
                val = v.text if v is not None else None
            cells[_col_index(c.get("r"))] = val
        rows.append((int(row.get("r")), [cells.get(i) for i in range((max(cells) + 1) if cells else 0)]))
    return rows


# ---------- cleaning ----------

def squash(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def tidy_name(value):
    s = squash(value)
    # Only change the case when the whole thing is shouting or all lower case.
    if s and (s.isupper() or s.islower()):
        s = re.sub(r"[A-Za-z]+('[A-Za-z]+)?", lambda m: m.group(0)[:1].upper() + m.group(0)[1:].lower(), s)
        s = re.sub(r"\bMc([a-z])", lambda m: "Mc" + m.group(1).upper(), s)
    return s


def tidy_phone(value):
    """Return (formatted, note). note is '' when the number looks right."""
    raw = squash(value)
    digits = re.sub(r"\D", "", raw)
    if digits.startswith("27") and len(digits) == 11:
        digits = "0" + digits[2:]
    if len(digits) == 9 and not digits.startswith("0"):
        return "", "9 digits (a leading 0 may have been lost)"
    if len(digits) == 10 and digits.startswith("0"):
        return f"{digits[:3]} {digits[3:6]} {digits[6:]}", ""
    return raw, f"{len(digits)} digits, please check"


def tidy_email(value):
    s = squash(value).lower().replace(" ", "")
    return s


def load_members(path, keep_address):
    rows = read_first_sheet(path)
    if not rows:
        sys.exit("The spreadsheet is empty.")
    header_row, header = rows[0]
    index = {squash(h).upper(): i for i, h in enumerate(header)}

    def need(*names):
        for n in names:
            if n in index:
                return index[n]
        sys.exit(f"Could not find a column called one of: {', '.join(names)}. Found: {', '.join(index) or 'none'}")

    c_name, c_sur = need("NAME", "FIRST NAME"), need("SURNAME", "LAST NAME")
    c_tel = need("CONTACT NO.", "CONTACT NO", "PHONE", "CELL")
    c_mail = need("EMAIL ADDRESS", "EMAIL")
    c_addr = index.get("HOME ADDRESS") if keep_address else None

    members, issues = [], []
    for row_no, cells in rows[1:]:
        def get(i):
            return cells[i] if i is not None and i < len(cells) else None
        if not any(squash(v) for v in cells):
            continue
        first, last = tidy_name(get(c_name)), tidy_name(get(c_sur))
        phone, phone_note = tidy_phone(get(c_tel))
        email = tidy_email(get(c_mail))
        if not first or not last:
            issues.append((row_no, "missing first or last name"))
        if phone_note:
            issues.append((row_no, "phone: " + phone_note))
        if email and not EMAIL_RE.match(email):
            issues.append((row_no, "email does not look valid"))
        if not email and not phone:
            issues.append((row_no, "no email and no phone"))
        notes = []
        if phone_note:
            notes.append("Check the phone number on file")
        if email and not EMAIL_RE.match(email):
            notes.append(f"Email on file was incomplete: {email}")
            email = ""
        m = {"row": row_no, "first": first, "last": last, "fullName": f"{first} {last}".strip(), "phone": phone, "email": email, "notes": notes}
        if keep_address:
            m["address"] = squash(get(c_addr))
        members.append(m)

    # duplicates
    by_email, by_name = {}, {}
    for m in members:
        if m["email"]:
            by_email.setdefault(m["email"], []).append(m["row"])
        by_name.setdefault((m["fullName"].lower(), m["phone"]), []).append(m["row"])
    shared_email = {e: r for e, r in by_email.items() if len(r) > 1}
    for rows_sharing in shared_email.values():
        for m in members:
            if m["row"] in rows_sharing[1:]:
                m["notes"].append("Shares an email address with another member, so only one of them can use it for a member login")
    same_person = {k: r for k, r in by_name.items() if len(r) > 1}
    for rs in shared_email.values():
        issues.append((rs[0], f"same email on rows {', '.join(map(str, rs))}"))
    for rs in same_person.values():
        issues.append((rs[0], f"looks like the same person on rows {', '.join(map(str, rs))}"))
    return members, sorted(set(issues))


# ---------- output ----------

def sql_text(value):
    return "null" if not value else "'" + value.replace("'", "''") + "'"


def write_files(members, out_dir, church_id, keep_address):
    os.makedirs(out_dir, exist_ok=True)

    csv_path = os.path.join(out_dir, "members-clean.csv")
    cols = ["Name", "Surname", "Phone", "Email", "Notes"] + (["Address"] if keep_address else [])
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for m in members:
            w.writerow([m["first"], m["last"], m["phone"], m["email"], ". ".join(m["notes"])] + ([m["address"]] if keep_address else []))

    sql_path = os.path.join(out_dir, "supabase-import-members.sql")
    values = ",\n    ".join(
        f"({sql_text(m['fullName'])}, {sql_text(m['phone'])}, {sql_text(m['email'])}, {sql_text('. '.join(m['notes']))})" for m in members
    )
    with open(sql_path, "w", encoding="utf-8") as f:
        f.write(
            "-- Imports the existing church members into ChurchHub.\n"
            "-- Run this ONCE in the Supabase SQL editor, AFTER supabase/website-integration.sql.\n"
            "-- 1. Replace PASTE-CHURCH-ID-HERE with your church id (Table editor > churches > id).\n"
            "-- 2. Run it. Running it again will not add anyone twice (matched on email).\n"
            "-- Everyone is added as an ACTIVE member with source 'import'.\n"
            "-- This file contains personal details: keep it private, never commit or share it.\n\n"
            "do $$\n"
            f"declare v_church uuid := '{church_id or 'PASTE-CHURCH-ID-HERE'}';\n"
            "begin\n"
            "  insert into members (church_id, full_name, phone, email, is_active, source)\n"
            "  select v_church, v.full_name, v.phone, v.email, true, 'import'\n"
            "  from (values\n"
            f"    {values}\n"
            "  ) as v(full_name, phone, email)\n"
            "  where not exists (\n"
            "    select 1 from members m\n"
            "    where m.church_id = v_church\n"
            "      and ((v.email is not null and lower(m.email) = lower(v.email))\n"
            "        or (v.email is null and lower(m.full_name) = lower(v.full_name)))\n"
            "  );\n"
            "end $$;\n"
        )
    return csv_path, sql_path


def add_to_local(members, project_dir):
    path = os.path.join(project_dir, "data", "members.json")
    existing = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            existing = json.load(f)
    have = {(m.get("email") or "").lower() for m in existing if m.get("email")}
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    added = 0
    for m in members:
        if m["email"] and m["email"] in have:
            continue
        existing.append({
            "id": str(uuid.uuid4()), "fullName": m["fullName"], "email": m["email"], "phone": m["phone"],
            "notes": ". ".join(m["notes"]), "status": "active", "source": "import", "consentAt": None, "createdAt": now, "joinedAt": None,
        })
        added += 1
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(existing, f, indent=2)
    return added


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--out", default=os.path.join(os.path.expanduser("~"), "Downloads", "CBC-import"))
    ap.add_argument("--address", action="store_true")
    ap.add_argument("--church-id", default="")
    ap.add_argument("--local", action="store_true")
    a = ap.parse_args()

    members, issues = load_members(a.xlsx, a.address)
    with_email = sum(1 for m in members if m["email"])
    with_phone = sum(1 for m in members if m["phone"])
    print(f"Members read: {len(members)}")
    print(f"  with an email: {with_email}   with a phone: {with_phone}")
    print(f"Things to check: {len(issues)} (each is also noted on that member so a leader can fix it)")
    for row, text in issues:
        print(f"  row {row}: {text}")

    if a.write:
        csv_path, sql_path = write_files(members, a.out, a.church_id, a.address)
        print(f"\nWrote (outside the project, not synced to GitHub):\n  {csv_path}\n  {sql_path}")
    if a.local:
        project = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        print(f"\nAdded {add_to_local(members, project)} members to the local demo server data (data/members.json).")
    if not a.write and not a.local:
        print("\nReport only. Nothing was written. Add --write to create the import files.")


if __name__ == "__main__":
    main()
