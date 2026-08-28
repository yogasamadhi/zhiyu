from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

root = Path(SPECPATH).parent
datas = collect_data_files("jieba")
hiddenimports = [
    "datasketch",
    "duckdb",
    "jieba.analyse",
    "numpy",
    "pandas",
    "polars",
    "pyarrow.parquet",
    "scipy.stats",
    "sklearn.cluster",
    "sklearn.decomposition",
    "sklearn.ensemble",
    "sklearn.feature_extraction.text",
    "sklearn.linear_model",
    "sklearn.metrics",
    "sklearn.model_selection",
    "sklearn.pipeline",
    "sklearn.preprocessing",
    "statsmodels.api",
    "statsmodels.tsa.arima.model",
]

analysis = Analysis(
    [str(root / "packaging" / "entrypoint.py")],
    pathex=[str(root / "src")],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=[
        "hypothesis",
        "matplotlib",
        "pandas.tests",
        "pytest",
        "sklearn.tests",
        "torch",
    ],
    noarchive=False,
)
pyz = PYZ(analysis.pure)
executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="analytics-worker",
    console=True,
)
collection = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="analytics-worker",
)
