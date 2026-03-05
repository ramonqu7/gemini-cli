import json
import sys
import re

try:
    with open('/usr/local/google/home/ramonqu/.gemini/tmp/gemini-cli/tool-outputs/session-aeba609f-f499-420b-9271-744739a11381/f1__execute_query_1772701453380_0.txt', 'r') as f:
        content = f.read()
except Exception as e:
    print(f"Error reading file: {e}")
    sys.exit(1)

def extract_json(job_id):
    pattern = rf'{job_id}\s+(\{{.*\}})'
    match = re.search(pattern, content)
    if match:
        return match.group(1)
    return None

def find_actions(job_name, json_str):
    print(f"--- {job_name} ---")
    if not json_str:
        return
    if 'Superluminal' in json_str or 'FlattenCompute' in json_str:
        print("  FOUND keyword in raw JSON string!")
    else:
        print("  NO planner actions found in tree and NO keywords found in raw JSON.")

slow_id = 'script_job_8ec1b38a76c9f00916c19349d618164d_1'
find_actions(f"Old Slow Job ({slow_id})", extract_json(slow_id))

