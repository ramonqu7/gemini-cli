import json
import sys
import re

# Load the query output from the first inspector stats attempt
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

def find_actions(job_name, json_str):
    print(f"--- {job_name} ---")
    if not json_str:
        return
        
    try:
        data = json.loads(json_str)
        # Deep search for plannerActions
        def find_key(obj, key):
            if isinstance(obj, dict):
                if key in obj:
                    return obj[key]
                for v in obj.values():
                    res = find_key(v, key)
                    if res is not None:
                        return res
            elif isinstance(obj, list):
                for item in obj:
                    res = find_key(item, key)
                    if res is not None:
                        return res
            return None

        actions = find_key(data, 'plannerActions')
        if not actions:
            # Let's search string representation for hints
            if 'Superluminal' in json_str or 'FlattenCompute' in json_str:
                print("  FOUND keyword in raw JSON string!")
            else:
                print("  NO planner actions found in tree and NO keywords found in raw JSON.")
            return

        for action in actions:
            name = action.get('name', 'UNKNOWN')
            print(f"  - {name}")
            
    except Exception as e:
        print(f"  Error: {e}")

slow_id = 'script_job_82d0bd0c70fdc924dfec076eec435c53_1'
fast_id = 'script_job_3768d3cc214b60efd91bd76b83465463_1'

find_actions(f"Slow Job ({slow_id})", extract_json(slow_id))
find_actions(f"Fast Job ({fast_id})", extract_json(fast_id))

