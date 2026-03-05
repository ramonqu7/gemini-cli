import json
import sys
import re

# Load the query output
try:
    with open('/usr/local/google/home/ramonqu/.gemini/tmp/gemini-cli/tool-outputs/session-aeba609f-f499-420b-9271-744739a11381/f1__execute_query_1772705571216_0.txt', 'r') as f:
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

def list_all_actions(job_name, json_str):
    print(f"--- {job_name} ---")
    if not json_str:
        print("  No data found.")
        return
        
    try:
        data = json.loads(json_str)
        actions = data.get('plannerStatistics', {}).get('planGuideStatistics', {}).get('plannerActions', [])
        
        if not actions:
             print("  No actions list found.")
             
        for action in actions:
            name = action.get('name', 'UNKNOWN')
            print(f"  - {name}")
            
    except Exception as e:
        print(f"  Error parsing JSON: {e}")

slow_id = 'script_job_82d0bd0c70fdc924dfec076eec435c53_1'
fast_id = 'script_job_3768d3cc214b60efd91bd76b83465463_1'

list_all_actions(f"Slow Job ({slow_id})", extract_json(slow_id))
list_all_actions(f"Fast Job ({fast_id})", extract_json(fast_id))

