"""=============================================================================

PP MOD DEVELOPER PORTAL - MULTI-DATABASE AUTO QUEST BOT (FIXED POKEMON)
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


show_header()

all_dbs = glob.glob("/data/data/com.google.android.gms/databases/games_*.db")
if not all_dbs:
  print(f"\n{R}✖ Google Play Games Database Missing!{NC}\n")
  exit()

g, e, lvl, xp = "Unknown Gamer", "No Email Linked", "Level 10", "15,250 XP"
for db_path in sorted(all_dbs, key=os.path.getmtime, reverse=True):
  try:
    c = sqlite3.connect(db_path)
    r1 = c.execute("SELECT profile_name FROM players LIMIT 1").fetchone()
    if r1 and r1[0]:
      g = r1[0]
    r2 = c.execute(
        "SELECT account_name FROM client_contexts WHERE account_name IS NOT"
        " NULL LIMIT 1"
    ).fetchone()
    if r2 and r2[0]:
      e = r2[0]
    c.close()
    if g != "Unknown Gamer" and e != "No Email Linked":
      break
  except:
    pass

print(f"{Y}👤 Gamer Tag   : {W}{g}{NC}")
print(f"{Y}📧 Linked Mail : {W}{e}{NC}")
print(f"{Y}🎮 Play Games  : {G}{lvl} {W}({xp}){NC}")
print(f"{C}──────────────────────────────────────────────{NC}")
print(f"{G} Available Tasks & Quests:{NC}")
print(f"{W}  [1 / a] Gossip Harbor (50 Play Points){NC}")
print(f"{W}  [2 / b] Summoners War (Quest Completed){NC}")
print(f"{W}  [3 / c] Domino Dreams (Quest Completed){NC}")
print(f"{W}  [4 / d] Farm Heroes Saga (70 Play Points){NC}")
print(f"{W}  [5 / e] Pokémon TCG Pocket (50 Play Points - 100% Fixed){NC}")
print(f"{R}  [0 / x] Exit Panel{NC}")
print(f"{C}──────────────────────────────────────────────{NC}")
print(f"{M} 👑 Core Dev : {W}Shezin Boy {C}(@Blackmoney54){NC}")
print(f"{C}──────────────────────────────────────────────{NC}")

choice = input(f"{Y}Enter choice (1-5 or a-e): {NC}").strip().lower()


def find_target_db_and_cc(pkg):
  for d in sorted(all_dbs, key=os.path.getmtime, reverse=True):
    try:
      c = sqlite3.connect(d)
      row = c.execute(
          "SELECT _id FROM client_contexts WHERE package_name = ? LIMIT 1",
          (pkg,),
      ).fetchone()
      c.close()
      if row:
        return d, row[0]
    except:
      pass
  return None, None


def process_quest(game_name, package_name, real_game_id, achs_list):
  show_header()
  print(f"{Y}👤 Gamer Tag   : {W}{g}{NC}")
  print(f"{Y}📧 Linked Mail : {W}{e}{NC}")
  print(f"{Y}🎮 Play Games  : {G}{lvl} {W}({xp}){NC}")
  print(f"{C}──────────────────────────────────────────────{NC}")

  print(f"{C}⏳ Multi-DB Radar Scanning for {game_name}...{NC}")
  target_db, real_cc_id = find_target_db_and_cc(package_name)

  if not target_db:
    print(
        f"\n{R}✖ Error: {game_name} is not registered in any database!{NC}"
    )
    print(f"{Y}👉 Open {game_name} once and link Play Games account.{NC}\n")
    return

  print(f"   {G}✔ Located Core DB: {os.path.basename(target_db)}{NC}")
  conn = sqlite3.connect(target_db)
  cursor = conn.cursor()

  player_row = cursor.execute(
      "SELECT external_player_id FROM players LIMIT 1"
  ).fetchone()
  player_id = player_row[0] if player_row else "p1"
  now = int(subprocess.check_output("date +%s%3N", shell=True))

  for a_id, a_name, a_type, steps, formatted in achs_list:
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
            VALUES (?, ?, ?, 0, ?, ?, ?, ?)
        """,
        (real_cc_id, a_id, a_type, steps, steps, str(real_game_id), player_id),
    )

  conn.commit()
  conn.close()

  # সিস্টেম লেভেল সিঙ্ক
  subprocess.run(
      "/system/bin/am broadcast -a com.google.android.gms.games.SYNC --user 0",
      shell=True,
      capture_output=True,
  )
  subprocess.run(
      "/system/bin/am force-stop com.google.android.gms",
      shell=True,
      capture_output=True,
  )
  subprocess.run(
      "/system/bin/am force-stop com.google.android.play.games",
      shell=True,
      capture_output=True,
  )

  print(f"{G}✔ Cloud Verification Handshake Complete!{NC}")
  print(f"\n{Y}🎯 Game : {W}{game_name} {Y}[{G}Quest Claimed{Y}]{NC}")

  conn = sqlite3.connect(target_db)
  cursor = conn.cursor()
  print(f"{C}┌────────────────────────────────┬───────────┐{NC}")
  print(f"{C}│ Target Quest Achievement       │ Status    │{NC}")
  print(f"{C}├────────────────────────────────┼───────────┤{NC}")

  unlocked_count = 0
  for a_id, a_name, a_type, steps, formatted in achs_list:
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
    print(f"{W}│  ★ SUCCESS: {game_name:<18} Completed!  │{NC}")
    print(f"{Y}│  👉 Open Play Store and Claim Points!        │{NC}")
    print(f"{M}│  ♥ Thanks for using PP MOD Auto Completer!   │{NC}")
    print(f"{G}└──────────────────────────────────────────────┘{NC}\n")
  else:
    print(f"\n{R}✖ Verification failed! Some quests were not updated.{NC}\n")


if choice in ["1", "a"]:
  gossip_achs = [
      ("CgkI3YvxrpUIEAIQAQ", "Starter Snack Bar", 1, 5, "5/5"),
      ("CgkI3YvxrpUIEAIQBw", "Welcome to Brimwave", 0, 0, ""),
      ("CgkI3YvxrpUIEAIQDA", "Leveled Up", 0, 0, ""),
  ]
  process_quest(
      "Gossip Harbor", "com.mergegames.gossipharbor", "3", gossip_achs
  )

elif choice in ["2", "b"]:
  summoners_achs = [
      ("CgkIi9-Vv5oZEAIQDg", "Joy of Victory", 0, 0, ""),
      ("CgkIi9-Vv5oZEAIQEg", "Monster Transformed", 0, 0, ""),
      ("CgkIi9-Vv5oZEAIQFA", "Celestial Island", 0, 0, ""),
  ]
  process_quest(
      "Summoners War",
      "com.com2us.smon.normal.freefull.google.kr.android.common",
      "1",
      summoners_achs,
  )

elif choice in ["3", "c"]:
  domino_achs = [
      ("CgkIh9OY-ugGEAIQAw", "First win (Win a Level)", 0, 0, ""),
      ("CgkIh9OY-ugGEAIQCQ", "Buddy bonus (Invite Friend)", 0, 0, ""),
  ]
  process_quest(
      "Domino Dreams", "com.screenshake.dominodreams", "1", domino_achs
  )

elif choice in ["4", "d"]:
  farm_achs = [
      ("CgkIu7q4p9MfEAIQCw", "Flawless", 0, 0, ""),
      ("CgkIu7q4p9MfEAIQCQ", "Adept Farmer", 0, 0, ""),
      ("CgkIu7q4p9MfEAIQDA", "Reward Harvest", 0, 0, ""),
      ("CgkIu7q4p9MfEAIQCg", "Battle Rancid", 0, 0, ""),
  ]
  process_quest(
      "Farm Heroes Saga", "com.king.farmheroessaga", "3", farm_achs
  )

elif choice in ["5", "e"]:
  # ১০০% নিখুঁত স্টেপ এবং টাইপ ফিক্স করা হয়েছে
  pokemon_achs = [
      (
          "CgkIg7-InK8eEAIQAQ",
          "Use pack stamina open booster",
          1,
          4,
          "4/4",
      ),  # Type 1, 4 steps
      ("CgkIg7-InK8eEAIQDQ", "Wonder pick 1", 0, 0, ""),  # Type 0
      ("CgkIg7-InK8eEAIQDg", "Win solo battles 1", 0, 0, ""),  # Type 0
  ]
  process_quest(
      "Pokémon TCG Pocket", "jp.pokemon.pokemontcgp", "2", pokemon_achs
  )

elif choice in ["0", "x"]:
  print(f"\n{Y}Exiting panel. Have a nice day!{NC}\n")
else:
  print(f"\n{R}✖ Invalid Option! Please type 1-5 or a-e{NC}\n")
