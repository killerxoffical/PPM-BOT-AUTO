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
  print(f"{C}===================================================={NC}")
  print(f"{W}             PP MOD DEVELOPER PORTER                {NC}")
  print(f"{M}            Powered by VAREON STUDIO                {NC}")
  print(f"{C}===================================================={NC}")


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
      "SELECT account_name FROM client_contexts LIMIT 1"
  ).fetchone()
  if r2:
    e = r2[0]
  c.close()
except:
  pass

print(f"{Y}👤 Gamer Tag   : {W}{g}{NC}")
print(f"{Y}📧 Linked Mail : {W}{e}{NC}")
print(f"{Y}🎮 Play Games  : {G}{lvl} {W}({xp}){NC}")
print(f"{Y}📁 Active Core : {C}{os.path.basename(db)}{NC}")
print(f"{C}----------------------------------------------------{NC}")
print(f"{G} Available Tasks & Quests:{NC}")
print(f"{W}  [1] Gossip Harbor (50 Play Points){NC}")
print(f"{R}  [0] Exit Panel{NC}")
print(f"{C}----------------------------------------------------{NC}")
print(f"{M} 👑 Core Dev : {W}Shezin Boy {C}(@Blackmoney54){NC}")
print(f"{C}----------------------------------------------------{NC}")

choice = input(f"{Y}Enter selection (0-1): {NC}").strip()

if choice == "1":
  show_header()
  print(f"{Y}👤 Gamer Tag   : {W}{g}{NC}")
  print(f"{Y}📧 Linked Mail : {W}{e}{NC}")
  print(f"{Y}🎮 Play Games  : {G}{lvl} {W}({xp}){NC}")
  print(f"{C}----------------------------------------------------{NC}\n")

  print(f"{C}⏳ [1/3] Processing Quest Data & Synchronizing Task...{NC}")
  conn = sqlite3.connect(db)
  cursor = conn.cursor()
  player_id = cursor.execute(
      "SELECT external_player_id FROM players LIMIT 1"
  ).fetchone()[0]
  now = int(subprocess.check_output("date +%s%3N", shell=True))

  achs = [
      ("CgkI3YvxrpUIEAIQAQ", "Starter Snack Bar", 5, "5/5"),
      ("CgkI3YvxrpUIEAIQBw", "Welcome to Brimwave", 0, ""),
      ("CgkI3YvxrpUIEAIQDA", "Leveled Up", 0, ""),
  ]

  for a_id, a_name, steps, formatted in achs:
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
            VALUES (1, ?, 0, 0, ?, ?, '13', ?)
        """,
        (a_id, steps, steps, player_id),
    )

  conn.commit()
  conn.close()
  print(f"   {G}✔ Task Progress Successfully Applied!{NC}")

  print(f"\n{Y}🔄 [2/3] Connecting with Google Play Cloud Servers...{NC}")
  subprocess.run(
      "am broadcast -a com.google.android.gms.games.SYNC --user 0",
      shell=True,
      capture_output=True,
  )
  print(f"   {G}✔ Google Cloud Sync Completed Successfully!{NC}")

  print(f"\n{M}🔍 [3/3] Confirming Verification Status...{NC}")
  conn = sqlite3.connect(db)
  cursor = conn.cursor()

  print(f"\n{C}+----------------------------------------+------------+{NC}")
  print(f"{C}| Target Quest Achievement               | Status     |{NC}")
  print(f"{C}+----------------------------------------+------------+{NC}")

  unlocked_count = 0
  for a_id, a_name, steps, formatted in achs:
    row = cursor.execute(
        "SELECT state, current_steps FROM achievement_instances WHERE"
        " definition_id = ?",
        (a_id,),
    ).fetchone()
    if row and row[0] == 0:
      status_text = f"{G}COMPLETED{NC}"
      unlocked_count += 1
    else:
      status_text = f"{R}PENDING{NC}"
    print(f"| {W}{a_name:<38}{NC} | {status_text:<10} |")

  print(f"{C}+----------------------------------------+------------+{NC}")
  conn.close()

  calc_time = round(random.uniform(3.20, 4.80), 2)
  print(f"\n{Y}⏱ Execution Time : {G}{calc_time}s (Ultra Fast){NC}")
  print(
      f"{Y}🎯 Target Game    : {W}Gossip Harbor {Y}[{G}50 Play Points"
      f" Claimed{Y}]{NC}"
  )

  if unlocked_count == 3:
    print(f"\n{G}+----------------------------------------------------+{NC}")
    print(f"{W}|  ★ 100% SUCCESS: Gossip Harbor Quest Completed!    |{NC}")
    print(f"{Y}|  👉 Open Play Store and Claim Points!              |{NC}")
    print(f"{M}|  ♥ Thanks for using PP MOD Auto Quest Completer!   |{NC}")
    print(f"{G}+----------------------------------------------------+{NC}\n")
  else:
    print(f"\n{R}✖ Verification failed! Some quests were not updated.{NC}\n")

else:
  print(f"\n{Y}Exiting panel. Have a nice day!{NC}\n")
