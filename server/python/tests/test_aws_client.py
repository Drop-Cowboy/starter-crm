"""Credentials in the merged environment reach boto3, which itself reads only the process environment."""

from starter_crm.aws_util import client_config


def test_passes_on_credentials_from_the_merged_environment():
    config = client_config(
        {
            "AWS_REGION": "us-east-1",
            "AWS_ACCESS_KEY_ID": " key-1 ",
            "AWS_SECRET_ACCESS_KEY": "secret-1",
            "AWS_SESSION_TOKEN": "token-1",
        },
        "SQS",
    )
    assert config["aws_access_key_id"] == "key-1"
    assert config["aws_secret_access_key"] == "secret-1"
    assert config["aws_session_token"] == "token-1"
    assert config["region_name"] == "us-east-1"


def test_leaves_credentials_to_boto3_when_the_environment_has_none_or_only_half():
    for env in (
        {"AWS_REGION": "us-east-1"},
        {"AWS_ACCESS_KEY_ID": "key-1"},
        {"AWS_ACCESS_KEY_ID": "", "AWS_SECRET_ACCESS_KEY": ""},
    ):
        assert "aws_access_key_id" not in client_config(env, "SQS")


def test_omits_an_empty_session_token():
    config = client_config(
        {"AWS_ACCESS_KEY_ID": "key-1", "AWS_SECRET_ACCESS_KEY": "secret-1", "AWS_SESSION_TOKEN": " "}, "SSM"
    )
    assert "aws_session_token" not in config
