import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from banlist import formats
from banlist.cli import main
from banlist.duration import format_duration, parse_duration
from banlist.models import IP, PLAYER, BanEntry, looks_like_ip, now
from banlist.store import BanStore


class DurationTest(unittest.TestCase):
    def test_units(self):
        self.assertEqual(parse_duration("45s"), 45)
        self.assertEqual(parse_duration("30m"), 1800)
        self.assertEqual(parse_duration("7d"), 604800)
        self.assertEqual(parse_duration("1w"), 604800)

    def test_combined_and_case(self):
        self.assertEqual(parse_duration("1h30m"), 5400)
        self.assertEqual(parse_duration("2D 12H".replace(" ", "")), 216000)

    def test_permanent(self):
        for word in ("perm", "forever", "PERMANENT", None):
            self.assertIsNone(parse_duration(word))

    def test_invalid(self):
        for bad in ("", "abc", "7", "7y", "1h30"):
            with self.assertRaises(ValueError):
                parse_duration(bad)

    def test_format(self):
        self.assertEqual(format_duration(None), "永久")
        self.assertEqual(format_duration(5400), "1h30m")


class ModelTest(unittest.TestCase):
    def test_detects_ip(self):
        self.assertTrue(looks_like_ip("10.0.0.1"))
        self.assertTrue(looks_like_ip("10.0.0.0/24"))
        self.assertTrue(looks_like_ip("2001:db8::1"))
        self.assertFalse(looks_like_ip("Steve"))

    def test_player_match_is_case_insensitive(self):
        entry = BanEntry("Steve")
        self.assertTrue(entry.matches("steve"))
        self.assertTrue(entry.matches("STEVE"))
        self.assertFalse(entry.matches("Steve2"))

    def test_cidr_match(self):
        entry = BanEntry("192.168.1.0/24", kind=IP)
        self.assertTrue(entry.matches("192.168.1.200"))
        self.assertTrue(entry.matches("192.168.1.0/28"))
        self.assertFalse(entry.matches("192.168.2.1"))
        self.assertFalse(entry.matches("not-an-ip"))

    def test_expiry(self):
        moment = now()
        entry = BanEntry("Steve", expires=moment + timedelta(hours=1))
        self.assertTrue(entry.is_active(moment))
        self.assertEqual(entry.remaining(moment), 3600)
        self.assertFalse(entry.is_active(moment + timedelta(hours=2)))
        self.assertEqual(entry.remaining(moment + timedelta(hours=2)), 0)
        self.assertIsNone(BanEntry("Steve").remaining())

    def test_rejects_bad_input(self):
        with self.assertRaises(ValueError):
            BanEntry("Steve", kind="mob")
        with self.assertRaises(ValueError):
            BanEntry("   ").key


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "nested", "banlist.json")
        self.addCleanup(self.dir.cleanup)

    def store(self):
        return BanStore(self.path).load()

    def test_roundtrip(self):
        store = self.store()
        store.ban("Steve", reason="洗頻", expires=now() + timedelta(days=1))
        store.ban("10.0.0.0/8", kind=IP, reason="代理")
        store.save()

        reloaded = self.store()
        self.assertEqual(len(reloaded.listing()), 2)
        self.assertEqual(reloaded.find("STEVE", PLAYER).reason, "洗頻")
        self.assertEqual(reloaded.find("10.0.0.0/8", IP).kind, IP)

    def test_ban_replaces_existing(self):
        store = self.store()
        store.ban("Steve", reason="第一次")
        store.ban("steve", reason="第二次")
        self.assertEqual(len(store.entries), 1)
        self.assertEqual(store.find("Steve", PLAYER).reason, "第二次")
        with self.assertRaises(KeyError):
            store.ban("Steve", replace=False)

    def test_unban(self):
        store = self.store()
        store.ban("Steve")
        self.assertIsNotNone(store.unban("steve"))
        self.assertIsNone(store.unban("steve"))
        self.assertEqual(store.listing(), [])

    def test_matching_prefers_active_only(self):
        store = self.store()
        store.ban("Steve", expires=now() - timedelta(minutes=1))
        store.ban("10.0.0.0/24", kind=IP)
        self.assertEqual(store.matching("Steve"), [])
        self.assertEqual(len(store.matching("10.0.0.99")), 1)

    def test_purge_expired(self):
        store = self.store()
        store.ban("Old", expires=now() - timedelta(seconds=1))
        store.ban("Current")
        self.assertEqual(len(store.purge_expired()), 1)
        self.assertEqual([e.target for e in store.listing()], ["Current"])

    def test_audit_log(self):
        store = self.store()
        store.ban("Steve", source="admin")
        store.unban("Steve", source="admin")
        self.assertEqual([r["action"] for r in store.audit], ["ban", "unban"])
        self.assertEqual(store.audit[0]["actor"], "admin")

    def test_save_is_atomic_and_leaves_no_temp_files(self):
        store = self.store()
        store.ban("Steve")
        store.save()
        store.save()
        directory = os.path.dirname(self.path)
        self.assertEqual(os.listdir(directory), ["banlist.json"])

    def test_merge_respects_no_replace(self):
        store = self.store()
        store.ban("Steve", reason="舊的")
        added, updated, skipped = store.merge([BanEntry("steve", reason="新的")], replace=False)
        self.assertEqual((added, updated, skipped), (0, 0, 1))
        self.assertEqual(store.find("Steve", PLAYER).reason, "舊的")
        added, updated, skipped = store.merge([BanEntry("steve", reason="新的")])
        self.assertEqual((added, updated, skipped), (0, 1, 0))
        self.assertEqual(store.find("Steve", PLAYER).reason, "新的")


class FormatTest(unittest.TestCase):
    def entries(self):
        return [
            BanEntry("Steve", reason="外掛", uuid="069a79f4", expires=now() + timedelta(days=1)),
            BanEntry("1.2.3.4", kind=IP, reason="洗頻"),
        ]

    def test_minecraft_roundtrip(self):
        original = self.entries()
        players = formats.from_minecraft(formats.to_minecraft(original, PLAYER))
        self.assertEqual(len(players), 1)
        self.assertEqual(players[0].target, "Steve")
        self.assertEqual(players[0].uuid, "069a79f4")
        self.assertEqual(players[0].expires, original[0].expires)

        ips = formats.from_minecraft(formats.to_minecraft(original, IP))
        self.assertEqual(ips[0].kind, IP)
        self.assertIsNone(ips[0].expires)

    def test_minecraft_permanent_marker(self):
        dumped = json.loads(formats.dump_minecraft(self.entries(), IP))
        self.assertEqual(dumped[0]["expires"], "forever")
        self.assertEqual(dumped[0]["ip"], "1.2.3.4")

    def test_csv_roundtrip(self):
        parsed = formats.load_csv(formats.dump_csv(self.entries()))
        self.assertEqual([e.target for e in parsed], ["Steve", "1.2.3.4"])
        self.assertEqual(parsed[1].kind, IP)
        self.assertIsNone(parsed[1].expires)

    def test_json_roundtrip(self):
        parsed = formats.load_json(formats.dump_json(self.entries()))
        self.assertEqual(parsed[0].reason, "外掛")

    def test_load_json_accepts_minecraft_file(self):
        raw = formats.dump_minecraft(self.entries(), PLAYER)
        parsed = formats.load_json(raw)
        self.assertEqual(parsed[0].target, "Steve")


class CliTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "banlist.json")

    def run_cli(self, *argv):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            return main(["-f", self.path] + list(argv))

    def run_other(self, path, *argv):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            return main(["-f", path] + list(argv))

    def test_ban_check_unban_flow(self):
        self.assertEqual(self.run_cli("ban", "Griefer", "-r", "破壞", "--for", "7d"), 0)
        self.assertEqual(self.run_cli("check", "griefer", "-q"), 1)
        self.assertEqual(self.run_cli("unban", "GRIEFER"), 0)
        self.assertEqual(self.run_cli("check", "griefer", "-q"), 0)
        self.assertEqual(self.run_cli("unban", "GRIEFER"), 1)

    def test_ip_is_autodetected(self):
        self.run_cli("ban", "10.0.0.0/24", "-r", "代理")
        store = BanStore(self.path).load()
        self.assertEqual(store.listing()[0].kind, IP)
        self.assertEqual(self.run_cli("check", "10.0.0.5", "-q"), 1)

    def test_player_flag_forces_name(self):
        self.run_cli("ban", "10.0.0.1", "--player")
        self.assertEqual(BanStore(self.path).load().listing()[0].kind, PLAYER)

    def test_bad_duration_exits_with_error(self):
        self.assertEqual(self.run_cli("ban", "Steve", "--for", "7y"), 2)

    def test_until_in_the_past_is_rejected(self):
        with self.assertRaises(SystemExit):
            self.run_cli("ban", "Steve", "--until", "2000-01-01T00:00:00Z")

    def test_export_and_import_minecraft(self):
        self.run_cli("ban", "Steve", "-r", "外掛", "--uuid", "abc")
        self.run_cli("ban", "1.2.3.4", "-r", "洗頻")
        server = os.path.join(self.dir.name, "server")
        self.assertEqual(self.run_cli("export", "--format", "minecraft", "--out", server), 0)

        other = os.path.join(self.dir.name, "other.json")
        self.assertEqual(self.run_other(other, "import",
                                        os.path.join(server, "banned-players.json"),
                                        "--format", "minecraft"), 0)
        store = BanStore(other).load()
        self.assertEqual([e.target for e in store.listing()], ["Steve"])
        self.assertEqual(store.listing()[0].uuid, "abc")

    def test_export_csv_roundtrip_through_files(self):
        self.run_cli("ban", "Steve", "-r", "外掛")
        csv_path = os.path.join(self.dir.name, "out.csv")
        self.run_cli("export", "--format", "csv", "-o", csv_path)
        other = os.path.join(self.dir.name, "other.json")
        self.assertEqual(self.run_other(other, "import", csv_path), 0)
        self.assertEqual(BanStore(other).load().listing()[0].reason, "外掛")

    def test_list_and_log_and_purge(self):
        self.run_cli("ban", "Steve")
        self.assertEqual(self.run_cli("list", "--json"), 0)
        self.assertEqual(self.run_cli("log", "-n", "5"), 0)
        self.assertEqual(self.run_cli("purge"), 0)
        self.assertEqual(self.run_cli("list"), 0)

    def test_no_command_prints_help(self):
        self.assertEqual(self.run_cli(), 0)


if __name__ == "__main__":
    unittest.main()
