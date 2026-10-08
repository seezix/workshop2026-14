import os

import snapshots

JPEG = b"\xff\xd8\xff\xe0fake-jpeg\xff\xd9"


def test_save_writes_the_image_and_returns_a_valid_name(tmp_path):
    name = snapshots.save(tmp_path / "captures", JPEG)
    assert snapshots.is_valid_name(name)
    assert (tmp_path / "captures" / name).read_bytes() == JPEG


def test_two_captures_in_the_same_second_get_two_names(tmp_path):
    assert snapshots.save(tmp_path, JPEG, now=1e9) != snapshots.save(tmp_path, JPEG, now=1e9)


def test_save_returns_none_when_the_folder_cannot_be_written(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("pas un dossier")
    assert snapshots.save(blocker, JPEG) is None


def test_names_outside_the_pattern_are_refused():
    for name in ("../.env", "snap-20261008-140312-abcdef.png", "x.jpg",
                 "snap-20261008-140312-abcdef.jpg/../../.env", ""):
        assert not snapshots.is_valid_name(name)


def test_purge_only_removes_captures_older_than_24_hours(tmp_path):
    old = snapshots.save(tmp_path, JPEG)
    recent = snapshots.save(tmp_path, JPEG)
    other = tmp_path / "notes.txt"
    other.write_text("à garder")
    now = os.path.getmtime(tmp_path / recent)
    os.utime(tmp_path / old, (now - 25 * 3600, now - 25 * 3600))
    os.utime(other, (now - 25 * 3600, now - 25 * 3600))

    assert snapshots.purge(tmp_path, now=now) == 1
    assert not (tmp_path / old).exists()
    assert (tmp_path / recent).exists()
    assert other.exists()
