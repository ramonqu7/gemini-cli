import json
import sys

# Load the query output
try:
    with open('/usr/local/google/home/ramonqu/.gemini/tmp/gemini-cli/tool-outputs/session-aeba609f-f499-420b-9271-744739a11381/f1__execute_query_1772701961391_0.txt', 'r') as f:
        content = f.read()
except Exception as e:
    print(f"Error reading file: {e}")
    sys.exit(1)

# Extract JSON strings manually since the table format can be messy
slow_json_str = None
fast_json_str = None

for line in content.split('\n'):
    if 'script_job_8ec1b38a76c9f00916c19349d618164d_1' in line and '{' in line:
        slow_json_str = line[line.find('{'):]
    elif 'script_job_1446143316dfe67de19d488df270c538_1' in line and '{' in line:
        fast_json_str = line[line.find('{'):]

def analyze_job(job_name, json_str):
    if not json_str:
        print(f"No data for {job_name}")
        return
        
    data = json.loads(json_str)
    stages = data.get('stageStatistics', [])
    
    print(f"--- {job_name} ---")
    shuffles = {}
    
    for stage in stages:
        shuffle_id = stage.get('shuffleId')
        if not shuffle_id: continue
        
        written = int(stage.get('shuffleSourceBytesWritten', 0)) / (1024**4) # TB
        wait_ms = int(stage.get('shuffleQuotaWaitTimeMs', 0)) / 1000 / 60 # minutes
        
        if shuffle_id not in shuffles:
            shuffles[shuffle_id] = {'written_tb': 0, 'wait_mins': 0}
            
        shuffles[shuffle_id]['written_tb'] += written
        shuffles[shuffle_id]['wait_mins'] += wait_ms

    # Sort by data written
    sorted_shuffles = sorted(shuffles.items(), key=lambda x: x[1]['written_tb'], reverse=True)
    
    for sid, stats in sorted_shuffles:
        if stats['written_tb'] > 0.1: # Only show shuffles > 100GB
            print(f"Shuffle {sid}: {stats['written_tb']:.2f} TB written, {stats['wait_mins']:.2f} mins wait time")
    print()

analyze_job("Slow Job (script_job_8ec1b38a76c9f00916c19349d618164d_1)", slow_json_str)
analyze_job("Fast Job (script_job_1446143316dfe67de19d488df270c538_1)", fast_json_str)

