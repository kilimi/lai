#!/usr/bin/env python3

import os
from sqlalchemy import create_engine
from sqlalchemy.sql import text

def check_schema():
    db_url = os.environ.get('DATABASE_URL', 'postgresql://postgres:postgres@postgres:5432/lai_db')
    engine = create_engine(db_url)

    with engine.connect() as conn:
        print('=== ANNOTATION_FILES COLUMNS ===')
        result = conn.execute(text("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'annotation_files' ORDER BY ordinal_position"))
        annotation_files_cols = []
        for row in result:
            print(f'{row[0]}: {row[1]}')
            annotation_files_cols.append(row[0])
        
        print('\n=== DATASETS COLUMNS ===')
        result = conn.execute(text("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'datasets' ORDER BY ordinal_position"))
        datasets_cols = []
        for row in result:
            print(f'{row[0]}: {row[1]}')
            datasets_cols.append(row[0])
        
        print('\n=== ANALYSIS ===')
        print(f'annotation_files has file_path: {"file_path" in annotation_files_cols}')
        print(f'datasets has annotation_count: {"annotation_count" in datasets_cols}')

if __name__ == '__main__':
    check_schema()
