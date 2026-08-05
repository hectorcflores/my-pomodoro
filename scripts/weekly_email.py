#!/usr/bin/env python3
"""Weekly pomodoro email: this week's count vs the average of the past four
weeks, plus a couple of rule-based trends.

Weeks run Saturday 00:00 -> Friday 24:00 in America/Mexico_City, so the
Saturday-morning send always reports a complete week.

Config via environment (or a local .env, falling back to life-os/.env):
    SUPABASE_URL, SUPABASE_ANON_KEY, SYNC_KEY_HASH        # data
    GMAIL_ADDRESS, GMAIL_APP_PASSWORD, REPORT_RECIPIENT_EMAIL  # sending

Usage:
    python3 scripts/weekly_email.py --dry-run   # print the email, send nothing
    python3 scripts/weekly_email.py             # send it
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import re
import smtplib
import urllib.request
from collections import Counter
from email.message import EmailMessage
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Mexico_City")
ROOT = Path(__file__).resolve().parent.parent
ENV_PATHS = (
    ROOT / ".env",
    ROOT / "sync-config.local.json",  # handled separately below
    Path.home() / "Documents/projects/life-os/.env",
)
WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
                 "Saturday", "Sunday"]


def load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    for path in ENV_PATHS:
        if not path.exists():
            continue
        if path.suffix == ".json":
            cfg = json.loads(path.read_text(encoding="utf-8"))
            values.setdefault("SUPABASE_URL", cfg.get("supabaseUrl", ""))
            values.setdefault("SUPABASE_ANON_KEY", cfg.get("supabaseAnonKey", ""))
            values.setdefault("SYNC_KEY_HASH", cfg.get("syncKeyHash", ""))
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    for key in list(values):
        if os.environ.get(key):
            values[key] = os.environ[key]
    for key in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "SYNC_KEY_HASH",
                "GMAIL_ADDRESS", "GMAIL_APP_PASSWORD", "REPORT_RECIPIENT_EMAIL"):
        if os.environ.get(key):
            values[key] = os.environ[key]
    return values


def fetch_sessions(env: dict[str, str]) -> list[dict]:
    url = env["SUPABASE_URL"].rstrip("/") + "/rest/v1/rpc/list_focus_sessions"
    body = json.dumps({"p_sync_key_hash": env["SYNC_KEY_HASH"]}).encode()
    req = urllib.request.Request(url, data=body, headers={
        "apikey": env["SUPABASE_ANON_KEY"],
        "Authorization": f"Bearer {env['SUPABASE_ANON_KEY']}",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def week_start(reference: dt.datetime) -> dt.datetime:
    """Most recent Saturday 00:00 local at or before `reference`."""
    days_back = (reference.weekday() - 5) % 7
    day = (reference - dt.timedelta(days=days_back)).date()
    return dt.datetime.combine(day, dt.time.min, tzinfo=TZ)


def local_times(sessions: list[dict]) -> list[dt.datetime]:
    out = []
    for s in sessions:
        stamp = s["completed_at"].replace("Z", "+00:00")
        # Older Pythons need exactly 3 or 6 fractional digits; drop the fraction.
        stamp = re.sub(r"\.\d+", "", stamp)
        out.append(dt.datetime.fromisoformat(stamp).astimezone(TZ))
    return out


def build_report(times: list[dt.datetime], now: dt.datetime) -> dict:
    end = week_start(now)
    weeks = []  # newest first: [this week, w-1, w-2, w-3, w-4]
    for i in range(5):
        hi = end - dt.timedelta(days=7 * i)
        lo = hi - dt.timedelta(days=7)
        weeks.append([t for t in times if lo <= t < hi])
    this_week = weeks[0]
    prior = weeks[1:]
    prior_counts = [len(w) for w in prior]
    avg_prior = sum(prior_counts) / len(prior_counts) if prior_counts else 0.0

    trends: list[str] = []
    count = len(this_week)
    if avg_prior:
        delta_pct = (count - avg_prior) / avg_prior * 100
        if abs(delta_pct) >= 10:
            direction = "up" if delta_pct > 0 else "down"
            trends.append(
                f"You're {direction} {abs(delta_pct):.0f}% vs your 4-week average "
                f"({count} vs {avg_prior:.1f})."
            )
    if this_week:
        by_day = Counter(t.weekday() for t in this_week)
        best_day, best_n = by_day.most_common(1)[0]
        trends.append(
            f"{WEEKDAY_NAMES[best_day]} was your strongest day with "
            f"{best_n} pomodoro{'s' if best_n != 1 else ''}."
        )
        hours = sorted(t.hour for t in this_week)
        median_hour = hours[len(hours) // 2]
        prior_hours = sorted(t.hour for w in prior for t in w)
        if prior_hours:
            prior_median = prior_hours[len(prior_hours) // 2]
            if abs(median_hour - prior_median) >= 2:
                shift = "earlier" if median_hour < prior_median else "later"
                trends.append(
                    f"Your sessions shifted {shift}: median start around "
                    f"{median_hour}:00 vs {prior_median}:00 in prior weeks."
                )
        active_days = len({t.date() for t in this_week})
        trends.append(f"You showed up on {active_days} of 7 days.")
    else:
        trends.append("No completed pomodoros this week.")

    counts_by_week = [len(w) for w in weeks]  # newest first
    return {
        "window_end": end,
        "count": count,
        "avg_prior": avg_prior,
        "prior_counts": prior_counts,
        "counts_by_week": counts_by_week,
        "trends": trends[:3],
    }


def esc(s: str) -> str:
    return html.escape(s, quote=False)


def render_html(r: dict) -> str:
    week_lo = r["window_end"] - dt.timedelta(days=7)
    week_label = f"{week_lo.strftime('%b %-d')} – {(r['window_end'] - dt.timedelta(days=1)).strftime('%b %-d')}"
    rows = f"""
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">This week ({esc(week_label)})</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:bold;">{r['count']}</td>
      </tr>
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">Average, past 4 weeks</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">{r['avg_prior']:.1f}</td>
      </tr>"""
    for i, n in enumerate(r["prior_counts"], start=1):
        rows += f"""
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#888;">{i} week{'s' if i != 1 else ''} ago</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;color:#888;">{n}</td>
      </tr>"""
    trend_items = "".join(
        f'<li style="margin:0 0 6px;">{esc(t)}</li>' for t in r["trends"]
    )
    intro = (
        f"You completed {r['count']} pomodoro{'s' if r['count'] != 1 else ''} "
        f"this week — about {r['count'] * 30 // 60}h {r['count'] * 30 % 60:02d}m of focus."
    )
    return f"""
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;
              font-family:Georgia,'Times New Roman',serif;">
    <p style="font-size:15px;line-height:1.6;color:#333;">{esc(intro)}</p>
    <h2 style="font-size:17px;margin:28px 0 4px;color:#1a1a1a;">The numbers</h2>
    <table style="width:100%;border-collapse:collapse;font-size:15px;color:#333;margin-top:8px;">
      <tr>
        <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:13px;color:#888;font-weight:normal;">Period</th>
        <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:13px;color:#888;font-weight:normal;">Pomodoros</th>
      </tr>{rows}
    </table>
    <h2 style="font-size:17px;margin:28px 0 4px;color:#1a1a1a;">Trends</h2>
    <ul style="margin:8px 0 0;padding-left:20px;font-size:15px;line-height:1.6;color:#333;">
      {trend_items}
    </ul>
    <hr style="border:none;border-top:1px solid #ddd;margin:32px 0 12px;">
    <p style="font-size:12px;color:#aaa;">Generated from your focus sessions · my-pomodoro</p>
  </div>
"""


def render_text(r: dict) -> str:
    lines = [
        f"Pomodoros this week: {r['count']}",
        f"Average of past 4 weeks: {r['avg_prior']:.1f}",
        "",
        "Trends:",
    ]
    lines += [f"- {t}" for t in r["trends"]]
    lines += ["", "Generated from your focus sessions · my-pomodoro"]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true",
                        help="print the email instead of sending")
    args = parser.parse_args()

    env = load_env()
    sessions = fetch_sessions(env)
    now = dt.datetime.now(TZ)
    report = build_report(local_times(sessions), now)
    subject = f"Weekly pomodoros: {report['count']} this week vs {report['avg_prior']:.1f} avg"
    html_body = render_html(report)
    text_body = render_text(report)

    if args.dry_run:
        print(f"Subject: {subject}\n")
        print(text_body)
        print("\n--- HTML ---\n")
        print(html_body)
        return 0

    message = EmailMessage()
    message["From"] = env["GMAIL_ADDRESS"]
    message["To"] = env.get("REPORT_RECIPIENT_EMAIL") or env["GMAIL_ADDRESS"]
    message["Subject"] = subject
    message.set_content(text_body)
    message.add_alternative(html_body, subtype="html")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(env["GMAIL_ADDRESS"], env["GMAIL_APP_PASSWORD"])
        smtp.send_message(message)
    print("Sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
