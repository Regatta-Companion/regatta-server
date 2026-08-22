#!/usr/bin/env python3
"""garmin_sync.py — Sync Garmin Connect sailing activities to regatta-server.

Usage:
  python3 garmin_sync.py <api_base_url> <api_token> <user_id> <email> <password>

Downloads GPX files for sailing activities and uploads them via the
regatta-server track upload API. Skips activities already on the server.

Haalt daarnaast de laps op (get_activity_splits) en stuurt het startschot
mee als race_start_at. De Garmin-app zet op 0:00 een lapmarker, dus de
tweede lap begint op het moment dat de race begon. Zonder marker of bij een
onbekende JSON-vorm blijft race_start_at gewoon leeg — de track zelf is
belangrijker dan de marker.

Dependencies: pip install garminconnect
"""

import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

try:
    from garminconnect import (
        Garmin,
        GarminConnectAuthenticationError,
        GarminConnectTooManyRequestsError,
        GarminConnectConnectionError,
    )
except ImportError:
    print("ERROR: garminconnect niet geïnstalleerd. Run: pip install garminconnect", file=sys.stderr)
    sys.exit(1)


def load_already_uploaded(api_base: str, token: str) -> set:
    """Haal bestaande filenames op van de server."""
    try:
        req = Request(f"{api_base}/tracks", headers={"Authorization": f"Bearer {token}"})
        with urlopen(req, timeout=15) as resp:
            tracks = json.loads(resp.read())
        return {t.get("filename", "") for t in tracks if t.get("filename")}
    except Exception as e:
        print(f"  ⚠ Kon bestaande tracks niet ophalen: {e}", file=sys.stderr)
        return set()


def extract_race_start(splits) -> str:
    """Haal het startschot uit de splits-JSON van Garmin Connect.

    De vorm van dit antwoord is niet gedocumenteerd, dus we proberen de
    waarschijnlijke sleutels en geven None terug als niets past. In dat geval
    loggen we de werkelijke structuur naar stderr; de server bewaart die in
    garmin_links.sync_stderr, zodat we na de eerste echte sync weten hoe het
    antwoord eruitziet zonder te hoeven gokken.
    """
    if not isinstance(splits, dict):
        return None

    laps = None
    for key in ("lapDTOs", "splits", "activitySplits", "lapDtos"):
        value = splits.get(key)
        if isinstance(value, list) and value:
            laps = value
            break

    if laps is None:
        print(
            f"  ⚠ Geen laps herkend in splits-JSON; sleutels: {sorted(splits.keys())}",
            file=sys.stderr,
        )
        return None

    # De app zet één marker op 0:00, dus lap 1 is de aanloop en lap 2 begint
    # op het startschot. Zonder tweede lap is er niet gemarkeerd.
    if len(laps) < 2:
        return None

    second = laps[1]
    if not isinstance(second, dict):
        return None

    for key in ("startTimeGMT", "startTimeGmt", "startTime"):
        value = second.get(key)
        if value:
            return str(value)

    print(
        f"  ⚠ Lap zonder herkenbare starttijd; sleutels: {sorted(second.keys())}",
        file=sys.stderr,
    )
    return None


def upload_gpx(api_base: str, token: str, gpx_path: str, race_start_at: str = None) -> bool:
    """Upload een GPX bestand naar de regatta-server."""
    import io

    boundary = "----RegattaUploadBoundary"
    filename = os.path.basename(gpx_path)

    with open(gpx_path, "rb") as f:
        gpx_data = f.read()

    body = io.BytesIO()

    # Tekstveld vóór het bestand, zodat multer het zeker in req.body heeft
    if race_start_at:
        body.write(f"--{boundary}\r\n".encode())
        body.write(b'Content-Disposition: form-data; name="race_start_at"\r\n\r\n')
        body.write(race_start_at.encode())
        body.write(b"\r\n")

    body.write(f"--{boundary}\r\n".encode())
    body.write(
        f'Content-Disposition: form-data; name="gpx"; filename="{filename}"\r\n'.encode()
    )
    body.write(b"Content-Type: application/gpx+xml\r\n\r\n")
    body.write(gpx_data)
    body.write(f"\r\n--{boundary}--\r\n".encode())

    req = Request(
        f"{api_base}/tracks",
        data=body.getvalue(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )

    try:
        with urlopen(req, timeout=60) as resp:
            if resp.status in (201, 409):
                return True
            print(f"  ⚠ Upload mislukt: HTTP {resp.status}", file=sys.stderr)
            return False
    except Exception as e:
        # 409 Conflict = track bestaat al → niet als fout tellen
        if hasattr(e, 'code') and e.code == 409:
            return True
        print(f"  ⚠ Upload fout: {e}", file=sys.stderr)
        return False


def main():
    if len(sys.argv) != 6:
        print(
            "Usage: garmin_sync.py <api_base_url> <api_token> <user_id> <email> <password>",
            file=sys.stderr,
        )
        sys.exit(1)

    api_base = sys.argv[1].rstrip("/")
    api_token = sys.argv[2]
    user_id = sys.argv[3]
    garmin_email = sys.argv[4]
    garmin_password = sys.argv[5]

    print(f"Garmin Connect sync voor user {user_id} ({garmin_email})")
    print(f"API: {api_base}")

    # ── Login to Garmin Connect ──
    print("→ Inloggen bij Garmin Connect...")
    try:
        client = Garmin(garmin_email, garmin_password)
        client.login()
    except GarminConnectAuthenticationError:
        print("ERROR: Garmin Connect authenticatie mislukt — check email/wachtwoord.", file=sys.stderr)
        sys.exit(2)
    except GarminConnectTooManyRequestsError:
        print("ERROR: Te veel requests naar Garmin Connect — wacht even.", file=sys.stderr)
        sys.exit(3)
    except GarminConnectConnectionError as e:
        print(f"ERROR: Garmin Connect verbindingsfout: {e}", file=sys.stderr)
        sys.exit(4)

    print("  ✓ Ingelogd")

    # ── Get profile for display name ──
    try:
        profile = client.get_profile()
        display_name = profile.get("displayName", garmin_email)
        print(f"  Profiel: {display_name}")
    except Exception:
        display_name = garmin_email

    # ── Get already uploaded filenames ──
    already_uploaded = load_already_uploaded(api_base, api_token)
    print(f"  {len(already_uploaded)} tracks al op server")

    # ── Get recent activities ──
    print("→ Activiteiten ophalen...")
    try:
        activities = client.get_activities(0, 100)  # last 100 activities
    except Exception as e:
        print(f"ERROR: Kon activiteiten niet ophalen: {e}", file=sys.stderr)
        sys.exit(5)

    # Filter: sailing (zowel 'sailing' als nieuwere 'sailing_v2')
    sailing = [
        a
        for a in activities
        if a.get("activityType", {}).get("typeKey", "").lower() in ("sailing", "sailing_v2")
    ]

    # Debug: toon alle gevonden activity types
    type_counts = {}
    for a in activities:
        t = a.get("activityType", {}).get("typeKey", "onbekend")
        type_counts[t] = type_counts.get(t, 0) + 1
    print(f"  {len(activities)} activiteiten, {len(sailing)} zeil-activiteiten")
    if type_counts:
        print(f"  Types: {', '.join(f'{k}({v})' for k,v in sorted(type_counts.items(), key=lambda x:-x[1]))}")

    if not sailing:
        print("  Geen zeil-activiteiten gevonden.")
        return

    # ── Download and upload each new sailing activity ──
    uploaded = 0
    skipped = 0
    errors = 0

    with tempfile.TemporaryDirectory() as tmpdir:
        for activity in sailing:
            activity_id = activity.get("activityId")
            activity_name = activity.get("activityName", f"Activity {activity_id}")
            start_time = activity.get("startTimeLocal", "?")

            # Check if already uploaded (by filename convention)
            expected_filename = f"garmin_{activity_id}.gpx"
            if expected_filename in already_uploaded:
                skipped += 1
                continue

            print(f"  ↓ Download: {activity_name} ({start_time}) [id={activity_id}]")

            try:
                # Download GPX
                gpx_data = client.download_activity(
                    activity_id, dl_fmt=client.ActivityDownloadFormat.GPX
                )

                gpx_path = os.path.join(tmpdir, expected_filename)
                # gpx_data might be bytes or str
                if isinstance(gpx_data, bytes):
                    with open(gpx_path, "wb") as f:
                        f.write(gpx_data)
                else:
                    with open(gpx_path, "w") as f:
                        f.write(str(gpx_data))

                # Laps ophalen voor het startschot. Mislukt dit, dan gaat de
                # upload gewoon door zonder marker.
                race_start_at = None
                try:
                    race_start_at = extract_race_start(
                        client.get_activity_splits(activity_id)
                    )
                except Exception as e:
                    print(f"  ⚠ Kon laps niet ophalen: {e}", file=sys.stderr)

                if race_start_at:
                    print(f"    ⚑ Startschot uit lapmarker: {race_start_at}")

                # Upload to server
                if upload_gpx(api_base, api_token, gpx_path, race_start_at):
                    print(f"    ✓ Geüpload als {expected_filename}")
                    already_uploaded.add(expected_filename)
                    uploaded += 1
                else:
                    errors += 1

                # Be nice to Garmin's servers
                time.sleep(1)

            except Exception as e:
                print(f"    ✗ Fout: {e}", file=sys.stderr)
                errors += 1

    print(f"\nKlaar: {uploaded} geüpload, {skipped} overgeslagen, {errors} fouten")


if __name__ == "__main__":
    main()
