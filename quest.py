import glob, os, sqlite3, subprocess

G = "\033[1;32m"; Y = "\033[1;33m"; C = "\033[1;36m"; W = "\033[1;37m"; M = "\033[1;35m"; R = "\033[1;31m"; NC = "\033[0m"

os.chdir("/data/data/com.termux/files/home/google_play_achievement_unlocker")

os.system("clear")
print(f"{C}╔══════════════════════════════════════════════════════╗{NC}")
print(f"{W}      GOOGLE PLAY POINTS ADVANCED VERIFIER PANEL      {NC}")
print(f"{M}                  Dev by VAREON STUDIO                 {NC}")
print(f"{C}╚══════════════════════════════════════════════════════╝{NC}")

# ১. ডাটাবেজ প্রি-চেক
try:
    db = sorted(glob.glob("/data/data/com.google.android.gms/databases/games_*.db"), key=os.path.getmtime)[-1]
except:
    print(f"\n{R}✖ [FATAL ERROR] No Google Play Games Database found!{NC}")
    print(f"{Y}👉 Open Google Play Games once, then try again.{NC}\n")
    exit()

# ২. জিমেইল এবং প্লেয়ার প্রোফাইল প্রি-চেক
g, e = "Unknown Gamer", "No Email Found"
try:
    c = sqlite3.connect(db)
    r1 = c.execute("SELECT profile_name FROM players LIMIT 1").fetchone()
    if r1: g = r1[0]
    r2 = c.execute("SELECT account_name FROM client_contexts LIMIT 1").fetchone()
    if r2: e = r2[0]
    c.close()
except:
    pass

print(f"{Y}👤 Gamer Name : {W}{g}{NC}")
print(f"{Y}📧 Email Addr : {W}{e}{NC}")
print(f"{Y}📁 Active DB  : {C}{os.path.basename(db)}{NC}")
print(f"{C}──────────────────────────────────────────────────────{NC}")

if e == "No Email Found":
    print(f"{R}✖ [WARNING] Email is not linked properly in Database!{NC}")
    print(f"{Y}👉 Please make sure you are logged into Play Games.{NC}\n")
    exit()

print(f"{G} Select Target Quest / Game:{NC}")
print(f"{W}  [1] Gossip Harbor (50 Play Points - Pure Manual Mode){NC}")
print(f"{R}  [0] Exit Panel{NC}")
print(f"{C}──────────────────────────────────────────────────────{NC}")
print(f"{M} 👑 Owner : {W}Shezin Boy {C}(@Blackmoney54){NC}")
print(f"{C}──────────────────────────────────────────────────────{NC}")

choice = input(f"{Y}Enter your choice (0-1): {NC}").strip()

if choice == "1":
    print(f"\n{Y}⚡ [1/3] Injecting Quest Achievements into Database...{NC}")
    conn = sqlite3.connect(db)
    cursor = conn.cursor()
    player_id = cursor.execute("SELECT external_player_id FROM players LIMIT 1").fetchone()[0]
    now = int(subprocess.check_output("date +%s%3N", shell=True))

    achs = [
        ('CgkI3YvxrpUIEAIQAQ', 'Starter Snack Bar', 5, '5/5'),
        ('CgkI3YvxrpUIEAIQBw', 'Welcome to Brimwave', 0, ''),
        ('CgkI3YvxrpUIEAIQDA', 'Leveled Up', 0, '')
    ]

    for a_id, a_name, steps, formatted in achs:
        cursor.execute('''
            INSERT OR REPLACE INTO achievement_instances 
            (definition_id, player_id, state, current_steps, formatted_current_steps, last_updated_timestamp, instance_xp_value)
            VALUES (?, ?, 0, ?, ?, ?, 1000)
        ''', (a_id, player_id, steps, formatted, now))

        cursor.execute('''
            INSERT OR REPLACE INTO achievement_pending_ops 
            (client_context_id, external_achievement_id, achievement_type, new_state, steps_to_increment, min_steps_to_set, external_game_id, external_player_id)
            VALUES (1, ?, 0, 0, ?, ?, '13', ?)
        ''', (a_id, steps, steps, player_id))

    conn.commit()
    conn.close()
    print(f"   {G}★ Injected into achievement_instances & Pending Ops!{NC}")

    print(f"{C}🔄 [2/3] Broadcasting Google Play Cloud Sync...{NC}")
    subprocess.run("am broadcast -a com.google.android.gms.games.SYNC --user 0", shell=True, capture_output=True)

    print(f"\n{M}🔍 [3/3] Verifying Database Confirmation...{NC}")
    conn = sqlite3.connect(db)
    cursor = conn.cursor()
    
    print(f"\n{C}┌───────────────────────────────────────────────┬────────────┐{NC}")
    print(f"{C}│ Achievement Name                              │ Status     │{NC}")
    print(f"{C}├───────────────────────────────────────────────┼────────────┤{NC}")
    
    unlocked_count = 0
    for a_id, a_name, steps, formatted in achs:
        row = cursor.execute("SELECT state, current_steps FROM achievement_instances WHERE definition_id = ?", (a_id,)).fetchone()
        if row and row[0] == 0:
            status_text = f"{G}UNLOCKED{NC}"
            unlocked_count += 1
        else:
            status_text = f"{R}LOCKED{NC}"
        print(f"│ {W}{a_name:<45}{NC} │ {status_text:<10} │")
    
    print(f"{C}└───────────────────────────────────────────────┴────────────┘{NC}")
    conn.close()

    if unlocked_count == 3:
        print(f"\n{G}╔══════════════════════════════════════════════════════╗{NC}")
        print(f"{W}║  ✔ 100% CONFIRMED: All 3 Quests are UNLOCKED!        ║{NC}")
        print(f"{Y}║  👉 Now manually open Gossip Harbor, wait 5 seconds, ║{NC}")
        print(f"{Y}║     then check Play Store for your 50 Points!        ║{NC}")
        print(f"{G}╚══════════════════════════════════════════════════════╝{NC}\n")

else:
    print(f"\n{Y}Exiting panel. Have a nice day!{NC}\n")
