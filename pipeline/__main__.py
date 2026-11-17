"""Run with python3 -m pipeline --help from the repository root."""
import argparse
import json
from pathlib import Path
from .store import Store


def main():
    parser = argparse.ArgumentParser(description='Local evidence staging and explicit AI review import')
    parser.add_argument('--db', default='pipeline/runtime/facilities.sqlite3')
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('init', 'status', 'pending'):
        commands.add_parser(command)
    commands.add_parser('inspect').add_argument('proposal_id')
    for command in ('stage', 'review'):
        commands.add_parser(command).add_argument('input', type=Path)
    correction = commands.add_parser('stage-correction')
    correction.add_argument('candidate', type=Path)
    correction.add_argument('correction', type=Path)
    commands.add_parser('export').add_argument('output', type=Path)
    args = parser.parse_args()
    store = Store(args.db)
    try:
        if args.command == 'init':
            result = {'initialized': args.db}
        elif args.command in ('status', 'pending'):
            result = getattr(store, args.command)()
        elif args.command == 'inspect':
            result = store.inspect(args.proposal_id)
        elif args.command in ('stage', 'review'):
            payload = json.loads(args.input.read_text(), parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Invalid JSON constant: ' + value)))
            result = getattr(store, args.command)(payload)
        elif args.command == 'stage-correction':
            candidate_payload = json.loads(args.candidate.read_text(), parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Invalid JSON constant: ' + value)))
            correction_payload = json.loads(args.correction.read_text(), parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Invalid JSON constant: ' + value)))
            result = store.stage_correction(candidate_payload, correction_payload)
        else:
            records = store.export()
            if not records:
                raise ValueError('No approved records; refusing to replace an existing export with an empty file')
            args.output.parent.mkdir(parents=True, exist_ok=True)
            temporary = args.output.with_suffix(args.output.suffix + '.tmp')
            temporary.write_text(json.dumps(records, indent=2, ensure_ascii=False) + '\n')
            temporary.replace(args.output)
            result = {'exported': len(records), 'output': str(args.output)}
        print(json.dumps(result, indent=2))
    except (ValueError, TypeError, OSError) as error:
        parser.exit(2, 'Error: ' + str(error) + '\n')
    finally:
        store.close()


if __name__ == '__main__':
    main()
