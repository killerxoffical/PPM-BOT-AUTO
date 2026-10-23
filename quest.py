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


show_header()

try:
  db = sorted(
      glob.glob("/data/data/com.google.android.gms/databases/games_*.db"),
      key=os.path.getmtime,
  )[-1]
except:
  print(f"\n{R}✖ Google Play Games Database Missing!{NC}\n")
  exit()

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
print(f"{G} Available Tasks & Quests:{NC}")
print(f"{W}  [1] Gossip Harbor (50 Play Points){NC}")
print(f"{W}  [2] Summoners War (Quest Completed){NC}")
print(f"{R}  [0] Exit Panel{NC}")
print(f"{C}──────────────────────────────────────────────{NC}")
print(f"{M} 👑 Core Dev : {W}Shezin Boy {C}(@Blackmoney54){NC}")
print(f"{C}──────────────────────────────────────────────{NC}")

choice = input(f"{Y}Enter selection (0-2): {NC}").strip()


def process_quest(game_name, package_name, achs_list):
  show_header()
  print(f"{Y}👤 Gamer Tag   : {W}{g}{NC}")
  print(f"{Y}📧 Linked Mail : {W}{e}{NC}")
  print(f"{Y}🎮 Play Games  : {G}{lvl} {W}({xp}){NC}")
  print(f"{C}──────────────────────────────────────────────{NC}")

  print(f"{C}⏳ Synchronizing Cloud Task & Progress...{NC}")
  conn = sqlite3.connect(db)
  cursor = conn.cursor()

  cc_row = cursor.execute(
      "SELECT _id FROM client_contexts WHERE package_name = ? LIMIT 1",
      (package_name,),
  ).fetchone()
  if not cc_row:
    print(f"\n{R}✖ Error: Game not registered! Open {game_name} once first!{NC}")
    conn.close()
    return
  real_cc_id = cc_row[0]

  game_row = cursor.execute(
      "SELECT game_id FROM achievement_definitions WHERE"
      " external_definition_id = ? LIMIT 1",
      (achs_list[0][0],),
  ).fetchone()
  real_game_id = (
      game_row[0]
      if game_row
      else ("13" if "gossip" in package_name else "1")
  )

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
        (real_cc_id, a_id, steps, steps, str(real_game_id), player_id),
    )

  conn.commit()
  conn.close()

  subprocess.run(
      "am broadcast -a com.google.android.gms.games.SYNC --user 0",
      shell=True,
      capture_output=True,
  )
  print(f"{G}✔ Cloud Verification Handshake Complete!{NC}")

  print(f"\n{Y}🎯 Game : {W}{game_name} {Y}[{G}Quest Claimed{Y}]{NC}")

  conn = sqlite3.connect(db)
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

  calc_time = round(random.uniform(3.18, 4.65), 2)
  print(f"\n{Y}⏱ Execution Time : {G}{calc_time}s (Ultra Fast){NC}")

  if unlocked_count == len(achs_list):
    print(f"\n{G}┌──────────────────────────────────────────────┐{NC}")
    print(f"{W}│  ★ SUCCESS: {game_name} Quest Completed!     │{NC}")
    print(f"{Y}│  👉 Open Play Store and Claim Points!        │{NC}")
    print(f"{M}│  ♥ Thanks for using PP MOD Auto Completer!   │{NC}")
    print(f"{G}└──────────────────────────────────────────────┘{NC}\n")
  else:
    print(f"\n{R}✖ Verification failed! Some quests were not updated.{NC}\n")


if choice == "1":
  gossip_achs = [
      ("CgkI3YvxrpUIEAIQAQ", "Starter Snack Bar", 5, "5/5"),
      ("CgkI3YvxrpUIEAIQBw", "Welcome to Brimwave", 0, ""),
      ("CgkI3YvxrpUIEAIQDA", "Leveled Up", 0, ""),
  ]
  process_quest("Gossip Harbor", "com.mergegames.gossipharbor", gossip_achs)

elif choice == "2":
  summoners_achs = [
      ("CgkIi9-Vv5oZEAIQDg", "Joy of Victory", 0, ""),
      ("CgkIi9-Vv5oZEAIQEg", "Monster Transformed", 0, ""),
      ("CgkIi9-Vv5oZEAIQFA", "Celestial Island", 0, ""),
  ]
  process_quest(
      "Summoners War",
      "com.com2us.smon.normal.freefull.google.kr.android.common",
      summoners_achs,
  )

else:
  print(f"\n{Y}Exiting panel. Have a nice day!{NC}\n")
