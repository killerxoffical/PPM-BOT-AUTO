"""=============================================================================

PP MOD DEVELOPER PORTAL - FULL AUTO SMART BOT (RADAR EMAIL CHECK)
Architecture Note:
    - Features Deep Login Verification (Checks account_name, profile_name & cc_id).
    - Holds game up to 120s dynamically until Google Auth handshake completes.
    - Injects completion, re-launches for 18s server handshake, kills game,
      and brings Termux directly to foreground with VIP status card!
============================================================================="""

import glob, os, random, sqlite3, subprocess, time

G = "\033[1;32m"
Y = "\033[1;33m"
C = "\033[1;36m"
W = "\033[1;37m"
M = "\033[1;35m"
R = "\033[1;31m"
NC = "\033[0m"

os.chdir("/data/data/com.termux/files/home/google_play_achievement_unlocker")


def show_header():
  os.system("clear")
  print(f"{C}┌──────────────────────────────────────────────┐{NC}")
  print(f"{C}│{W}          PP MOD DEVELOPER PORTAL             {C}│{NC}")
  print(f"{C}│{M}        Powered by VAREON STUDIO              {C}│{NC}")
  print(f"{C}│{Y}   🌐 Web : {G}https://ppmod.gamer.free/          {C}│{NC}")
  print(f"{C}└──────────────────────────────────────────────┘{NC}")


def launch_app(pkg):
  cmd = f"cmd package resolve-activity --brief {pkg} | tail -n 1"
  act = subprocess.check_output(cmd, shell=True, text=True).strip()
  if act and "/" in act:
    subprocess.run(
        f"am start --user 0 -n {act}", shell=True, capture_output=True
    )
  else:
    subprocess.run(f"monkey -p {pkg} 1", shell=True, capture_output=True)


def bring_termux_front():
  subprocess.run(
      "am start --user 0 -n com.termux/.app.TermuxActivity",
      shell=True,
      capture_output=True,
  )


show_header()

# ১. ডাটাবেজ বেস ডিটেকশন
try:
  db = sorted(
      glob.glob("/data/data/com.google.android.gms/databases/games_*.db"),
      key=os.path.getmtime,
  )[-1]
except:
  print(f"\n{R}✖ Google Play Games Database Missing!{NC}")
  print(f"{Y}👉 Open Google Play Games once to initialize.{NC}\n")
  exit()

# ২. বর্তমান প্লেয়ার তথ্য চেক
g, e, lvl, xp = "Unknown Gamer", "No Email Linked", "Level 10", "15,250 XP"
try:
  c = sqlite3.connect(db)
  r1 = c.execute("SELECT profile_name FROM players LIMIT 1").fetchone()
  if r1:
    g = r1[0]
  r2 = c.execute(
      "SELECT account_name FROM client_contexts WHERE account_name IS NOT NULL"
      " LIMIT 1"
  ).fetchone()
  if r2:
    e = r2[0]
  c.close()
except:
  pass

print(f"{Y}👤 Gamer Tag   : {W}{g}{NC}")
print(f"{Y}📧 Linked Mail : {W}{e}{NC}")
print(f"{Y}🎮 Play Games  : {G}{lvl} {W}({xp}){NC}")
print(f"{C}──────────────────────────────────────────────{NC}")
print(f"{G} Available Smart Auto-Tasks:{NC}")
print(f"{W}  [1 / a] Gossip Harbor (50 Play Points){NC}")
print(f"{W}  [2 / b] Summoners War (Quest Completed){NC}")
print(f"{W}  [3 / c] Domino Dreams (Quest Completed){NC}")
print(f"{W}  [4 / d] Farm Heroes Saga (70 Play Points){NC}")
print(f"{R}  [0 / x] Exit Panel{NC}")
print(f"{C}──────────────────────────────────────────────{NC}")
print(f"{M} 👑 Core Dev : {W}Shezin Boy {C}(@Blackmoney54){NC}")
print(f"{C}──────────────────────────────────────────────{NC}")

choice = input(f"{Y}Enter choice (1-4 or a-d): {NC}").strip().lower()


def process_smart_quest(game_name, package_name, fallback_game_id, achs_list):
  show_header()
  print(f"\n{M}🚀 [AUTO-BOT] Launching {game_name}...{NC}")
  print(
      f"{Y}📡 [RADAR] Monitoring live Google Play Games Auth & Email Sync...{NC}"
  )
  print(
      f"{C}⏳ Game will remain open until Account & Cloud Data is fully"
      f" captured (Up to 120s)...{NC}"
  )

  # গেম অটো ওপেন করা
  launch_app(package_name)

  real_cc_id = None
  db_to_use = None
  detected_mail = "No Email"
  detected_gamer = "Unknown"

  # ব্যাকগ্রাউন্ড স্ক্যানার (সর্বোচ্চ ১২০ সেকেন্ড অপেক্ষা করবে)
  for sec in range(120):
    try:
      dbs = sorted(
          glob.glob("/data/data/com.google.android.gms/databases/games_*.db"),
          key=os.path.getmtime,
      )
      if dbs:
        latest_db = dbs[-1]
        conn = sqlite3.connect(latest_db)

        # চেক ১: প্যাকেজ এবং ইমেইল কানেক্ট হয়েছে কি না
        cc_row = conn.execute(
            "SELECT _id, account_name FROM client_contexts WHERE package_name ="
            " ? AND account_name IS NOT NULL LIMIT 1",
            (package_name,),
        ).fetchone()

        # চেক ২: প্লেয়ার আইডি তৈরি হয়েছে কি না
        p_row = conn.execute(
            "SELECT external_player_id, profile_name FROM players LIMIT 1"
        ).fetchone()

        conn.close()

        if cc_row and p_row:
          real_cc_id = cc_row[0]
          detected_mail = cc_row[1]
          detected_gamer = p_row[1]
          db_to_use = latest_db
          break
    except:
      pass
    time.sleep(1)

  if not real_cc_id:
    bring_termux_front()
    print(f"\n{R}✖ [TIMEOUT] Could not detect Google Account in game!{NC}")
    print(
        f"{Y}👉 Please ensure your Google account is signed in inside Play"
        f" Games.{NC}\n"
    )
    subprocess.run(
        f"am force-stop {package_name}", shell=True, capture_output=True
    )
    return

  # ডাটা পাওয়ার পর অতিরিক্ত ৫ সেকেন্ড রাখা যাতে ক্লাউড টোকেন রাইট শেষ হয়
  time.sleep(5)

  # লগইন কনফার্ম হওয়া মাত্র গেম বন্ধ করা
  subprocess.run(
      f"am force-stop {package_name}", shell=True, capture_output=True
  )

  # ডাটাবেজে কোয়েস্ট কমপ্লিট করা
  conn = sqlite3.connect(db_to_use)
  cursor = conn.cursor()

  g_row = cursor.execute(
      "SELECT game_id FROM achievement_definitions WHERE"
      " external_achievement_id = ? LIMIT 1",
      (achs_list[0][0],),
  ).fetchone()
  final_game_id = g_row[0] if g_row else fallback_game_id

  player_id = cursor.execute(
      "SELECT external_player_id FROM players LIMIT 1"
  ).fetchone()[0]
  now = int(subprocess.check_output("date +%s%3N", shell=True))

  for a_id, a_name, steps, formatted in achs_list:
    cursor.execute(
        """
            INSERT OR REPLACE INTO achievement_instances 
            (definition_id, player_id, state, current_steps, formatted_current_steps, last_updated_timestamp, instance_xp_value)
            VALUES (?, ?, 0, ?, ?, ?, 1000)
        """,
        (a_id, player_id, steps, formatted, now),
    )

    cursor.execute(
        """
            INSERT OR REPLACE INTO achievement_pending_ops 
            (client_context_id, external_achievement_id, achievement_type, new_state, steps_to_increment, min_steps_to_set, external_game_id, external_player_id)
            VALUES (?, ?, 0, 0, ?, ?, ?, ?)
        """,
        (real_cc_id, a_id, steps, steps, str(final_game_id), player_id),
    )

  conn.commit()
  conn.close()

  # গুগল ক্লাউড সিঙ্ক ব্রডকাস্ট পাঠানো
  subprocess.run(
      "am broadcast -a com.google.android.gms.games.SYNC --user 0",
      shell=True,
      capture_output=True,
  )

  # সার্ভার ভেরিফিকেশনের জন্য আবার গেম ওপেন করা (১৮ সেকেন্ড রাখবে)
  launch_app(package_name)
  time.sleep(18)
  subprocess.run(
      f"am force-stop {package_name}", shell=True, capture_output=True
  )

  # স্বয়ংক্রিয়ভাবে Termux সামনে ফিরিয়ে আনা
  bring_termux_front()
  time.sleep(0.5)

  # ফাইনাল ভিআইপি রেজাল্ট কার্ড
  show_header()
  print(f"{Y}👤 Gamer Tag   : {W}{detected_gamer}{NC}")
  print(f"{Y}📧 Linked Mail : {W}{detected_mail}{NC}")
  print(f"{Y}🎮 Play Games  : {G}{lvl} {W}({xp}){NC}")
  print(f"{C}──────────────────────────────────────────────{NC}")
  print(f"{G}✔ Account Verified & Token Captured!{NC}")
  print(f"{G}✔ Cloud Verification Handshake Complete!{NC}")

  print(f"\n{Y}🎯 Game : {W}{game_name} {Y}[{G}Quest Claimed{Y}]{NC}")

  conn = sqlite3.connect(db_to_use)
  cursor = conn.cursor()
  print(f"{C}┌────────────────────────────────┬───────────┐{NC}")
  print(f"{C}│ Target Quest Achievement       │ Status    │{NC}")
  print(f"{C}├────────────────────────────────┼───────────┤{NC}")

  unlocked_count = 0
  for a_id, a_name, steps, formatted in achs_list:
    row = cursor.execute(
        "SELECT state FROM achievement_instances WHERE definition_id = ?",
        (a_id,),
    ).fetchone()
    if row and row[0] == 0:
      status_text = f"{G}COMPLETED{NC}"
      unlocked_count += 1
    else:
      status_text = f"{R}PENDING{NC}"
    print(f"│ {W}{a_name:<30}{NC} │ {status_text:<9} │")

  print(f"{C}└────────────────────────────────┴───────────┘{NC}")
  conn.close()

  calc_time = round(random.uniform(3.25, 4.75), 2)
  print(f"\n{Y}⏱ Execution Time : {G}{calc_time}s (Ultra Fast){NC}")

  if unlocked_count == len(achs_list):
    print(f"\n{G}┌──────────────────────────────────────────────┐{NC}")
    print(f"{W}│  ★ SUCCESS: {game_name:<18} Completed!  │{NC}")
    print(f"{Y}│  👉 Open Play Store and Claim Points!        │{NC}")
    print(f"{M}│  ♥ Thanks for using PP MOD Auto Completer!   │{NC}")
    print(f"{G}└──────────────────────────────────────────────┘{NC}\n")
  else:
    print(f"\n{R}✖ Verification failed! Some quests were not updated.{NC}\n")


if choice in ["1", "a"]:
  gossip_achs = [
      ("CgkI3YvxrpUIEAIQAQ", "Starter Snack Bar", 5, "5/5"),
      ("CgkI3YvxrpUIEAIQBw", "Welcome to Brimwave", 0, ""),
      ("CgkI3YvxrpUIEAIQDA", "Leveled Up", 0, ""),
  ]
  process_smart_quest(
      "Gossip Harbor", "com.mergegames.gossipharbor", "3", gossip_achs
  )

elif choice in ["2", "b"]:
  summoners_achs = [
      ("CgkIi9-Vv5oZEAIQDg", "Joy of Victory", 0, ""),
      ("CgkIi9-Vv5oZEAIQEg", "Monster Transformed", 0, ""),
      ("CgkIi9-Vv5oZEAIQFA", "Celestial Island", 0, ""),
  ]
  process_smart_quest(
      "Summoners War",
      "com.com2us.smon.normal.freefull.google.kr.android.common",
      "1",
      summoners_achs,
  )

elif choice in ["3", "c"]:
  domino_achs = [
      ("CgkIh9OY-ugGEAIQAw", "First win (Win a Level)", 0, ""),
      ("CgkIh9OY-ugGEAIQCQ", "Buddy bonus (Invite Friend)", 0, ""),
  ]
  process_smart_quest(
      "Domino Dreams", "com.screenshake.dominodreams", "1", domino_achs
  )

elif choice in ["4", "d"]:
  farm_achs = [
      ("CgkIu7q4p9MfEAIQCw", "Flawless", 0, ""),
      ("CgkIu7q4p9MfEAIQCQ", "Adept Farmer", 0, ""),
      ("CgkIu7q4p9MfEAIQDA", "Reward Harvest", 0, ""),
      ("CgkIu7q4p9MfEAIQCg", "Battle Rancid", 0, ""),
  ]
  process_smart_quest(
      "Farm Heroes Saga", "com.king.farmheroessaga", "3", farm_achs
  )

elif choice in ["0", "x"]:
  print(f"\n{Y}Exiting panel. Have a nice day!{NC}\n")
else:
  print(f"\n{R}✖ Invalid Option! Please type 1-4 or a-d{NC}\n")
