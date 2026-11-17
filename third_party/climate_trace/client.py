"""Selected official Climate TRACE client, adapted for a single bounded request.

Copyright (c) Climate TRACE Coalition. CC BY 4.0; see LICENSE and PROVENANCE.json.
Changes: subset only; disable redirects (no implicit extra requests), reject
non-200 responses; explicit timeout argument for get_sources.
"""
import requests

BASE_URL = "https://api.climatetrace.org/v7"
DEFAULT_TIMEOUT = 30

def _to_csv(value):
    """Coerce a list/tuple into the comma-separated string the API expects.

    Passing a plain string through unchanged lets callers supply either
    ``["agriculture", "power"]`` or ``"agriculture,power"``.
    """
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        return ",".join(str(v) for v in value)
    return value


def _get(endpoint, params=None, base_url=None, timeout=DEFAULT_TIMEOUT):
    """Send a GET request to the API and return the parsed JSON.

    Parameters
    ----------
    endpoint : str
        Path beginning with "/", e.g. "/sources/emissions".
    params : dict, optional
        Query parameters. Keys whose value is ``None`` are dropped.
    base_url : str, optional
        Override :data:`BASE_URL` for this call (e.g. to hit staging).
    timeout : int, optional
        Request timeout in seconds.

    Returns
    -------
    dict or list
        The decoded JSON response.

    Raises
    ------
    requests.HTTPError
        If the API returns a non-2xx status code.
    """
    url = f"{base_url or BASE_URL}{endpoint}"
    clean_params = {k: v for k, v in (params or {}).items() if v is not None}
    response = requests.get(url, params=clean_params, timeout=timeout, allow_redirects=False)
    response.raise_for_status()
    if response.status_code != 200:
        raise requests.HTTPError("Expected HTTP 200; redirects are not followed")
    return response.json()


def get_sources(
    year=None,
    gas=None,
    sectors=None,
    subsectors=None,
    gadm_id=None,
    city_id=None,
    country_group=None,
    continent=None,
    owner_ids=None,
    limit=None,
    offset=None,
    timeout=DEFAULT_TIMEOUT,
    **kwargs,
):
    """List individual emissions sources (assets), ranked by emissions.

    Endpoint: ``GET /v7/sources``

    Accepts the same filters as :func:`get_aggregate_emissions` (``year``,
    ``gas``, ``sectors``, ``subsectors``, ``gadm_id``, ``city_id``,
    ``country_group``, ``continent``, ``owner_ids``), plus ``limit`` (max
    results per call) and ``offset`` (number of results to skip) for
    pagination.

    Returns
    -------
    list
        Sources matching the filters, ranked by emissions.
    """
    params = {
        "year": year,
        "gas": gas,
        "sectors": _to_csv(sectors),
        "subsectors": _to_csv(subsectors),
        "gadmId": gadm_id,
        "cityId": city_id,
        "countryGroup": country_group,
        "continent": continent,
        "ownerIds": _to_csv(owner_ids),
        "limit": limit,
        "offset": offset,
        **kwargs,
    }
    return _get("/sources", params, timeout=timeout)
